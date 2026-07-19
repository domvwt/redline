import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { markdownToPlainText, PROJECT_PATH } from "@redline/shared";
import type { Annotation } from "@redline/shared";
import { reanchorAnnotation, reanchorFile } from "./anchoring.ts";
import { addAuthorReply, NotFoundError } from "./comments-service.ts";
import { DocStore, hashOf, PathError } from "./docs.ts";
import { EventHub } from "./events.ts";
import { loadBaseline, saveBaseline } from "./reviewed.ts";
import { loadSidecar, saveSidecar, touchAnnotation, withSidecarLock } from "./sidecar.ts";
import { listMarkdownFiles } from "./tree.ts";

const selectorSchema = z.object({
  quote: z.object({ exact: z.string().min(1), prefix: z.string(), suffix: z.string() }),
  position: z.object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() }),
});

const createCommentSchema = z.object({
  path: z.string().min(1),
  body: z.string().min(1),
  selector: selectorSchema.optional(), // absent = unanchored note
  /** doc hash the selector was computed against; certifies position hints */
  baseHash: z.string().optional(),
});

const patchCommentSchema = z.object({
  path: z.string().min(1),
  body: z.string().min(1).optional(),
  status: z.enum(["open", "resolved"]).optional(),
  resolutionNote: z.string().optional(),
  reply: z.string().min(1).optional(),
  /** rewrite one of the author's own entries in the thread */
  editReply: z
    .object({ index: z.number().int().nonnegative(), text: z.string().min(1) })
    .optional(),
  selector: selectorSchema.optional(), // re-attach an orphan
});

const importDocSchema = z.object({
  /** suggested name — sanitized to a root-level .md filename */
  name: z.string().min(1),
  markdown: z.string().min(1),
});

const putDocSchema = z.object({
  path: z.string().min(1),
  markdown: z.string(),
  baseHash: z.string(),
  anchors: z
    .array(
      z.object({
        id: z.string(),
        start: z.number().int().nonnegative(),
        end: z.number().int().nonnegative(),
      }),
    )
    .optional(),
});

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
};

export function buildApp(docs: DocStore, hub: EventHub): Hono {
  const app = new Hono();

  const guardPath = (relPath: string) => {
    if (relPath !== PROJECT_PATH) docs.resolve(relPath);
  };

  app.onError((err, c) => {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof PathError) return c.json({ error: err.message }, 400);
    if (err instanceof z.ZodError) return c.json({ error: err.message }, 400);
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return c.json({ error: "not found" }, 404);
    }
    console.error(err);
    return c.json({ error: "internal error" }, 500);
  });

  app.get("/api/tree", async (c) => c.json(await listMarkdownFiles(docs.root)));

  app.get("/api/doc", async (c) => {
    const relPath = c.req.query("path");
    if (!relPath) return c.json({ error: "path required" }, 400);
    const { markdown, hash } = await docs.read(relPath);
    // first look at a doc establishes its "reviewed" baseline
    let baseline = await loadBaseline(docs.root, relPath);
    if (baseline === null) {
      await saveBaseline(docs.root, relPath, markdown);
      baseline = markdown;
    }
    return c.json({ markdown, hash, changed: baseline !== markdown });
  });

  app.get("/api/baseline", async (c) => {
    const relPath = c.req.query("path");
    if (!relPath) return c.json({ error: "path required" }, 400);
    docs.resolve(relPath);
    const baseline = await loadBaseline(docs.root, relPath);
    return c.json({ markdown: baseline });
  });

  app.post("/api/reviewed", async (c) => {
    const { path: relPath } = z.object({ path: z.string().min(1) }).parse(await c.req.json());
    const { markdown } = await docs.read(relPath);
    await saveBaseline(docs.root, relPath, markdown);
    return c.json({ ok: true });
  });

  app.get("/api/search", async (c) => {
    const q = (c.req.query("q") ?? "").trim();
    if (q.length < 2) return c.json([]);
    // case-insensitive regex on the ORIGINAL text — lowercasing the haystack
    // is not length-preserving, which would skew reported offsets
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    const results: Array<{ path: string; start: number; end: number; snippet: string }> = [];
    for (const entry of await listMarkdownFiles(docs.root)) {
      const { markdown } = await docs.read(entry.path);
      const plain = markdownToPlainText(markdown);
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(plain)) !== null && results.length < 50) {
        const from = Math.max(0, m.index - 40);
        const to = Math.min(plain.length, m.index + m[0].length + 40);
        results.push({
          path: entry.path,
          start: m.index,
          end: m.index + m[0].length,
          snippet: (from > 0 ? "…" : "") + plain.slice(from, to) + (to < plain.length ? "…" : ""),
        });
        if (m.index === re.lastIndex) re.lastIndex++;
      }
      if (results.length >= 50) break;
    }
    return c.json(results);
  });

  app.put("/api/doc", async (c) => {
    const body = putDocSchema.parse(await c.req.json());
    const { hash: currentHash } = await docs.read(body.path);
    if (currentHash !== body.baseHash) {
      return c.json({ error: "document changed on disk; reload before saving" }, 409);
    }
    const hash = await docs.write(body.path, body.markdown);
    // your own edits are not "changes to review" — advance the baseline
    await saveBaseline(docs.root, body.path, body.markdown);
    try {
      await reanchorFile(docs, body.path, hub, body.anchors);
    } catch (err) {
      // the save itself succeeded; a re-anchor failure must not report it as failed
      console.error(`reanchor after save failed for ${body.path}:`, err);
    }
    return c.json({ hash });
  });

  // Import a document dropped or pasted into the UI. Never overwrites:
  // name collisions get a numeric suffix.
  app.post("/api/import", async (c) => {
    const body = importDocSchema.parse(await c.req.json());
    const base = path
      .basename(body.name)
      .replace(/\.(md|markdown|txt)$/i, "")
      .replace(/[^\p{L}\p{N}._ -]/gu, "")
      .trim()
      .replace(/\s+/g, "-");
    const slug = base || "imported";
    let rel = `${slug}.md`;
    for (let i = 1; ; i++) {
      try {
        await fs.access(docs.resolve(rel));
        rel = `${slug}-${i}.md`;
      } catch {
        break; // name is free
      }
    }
    await docs.write(rel, body.markdown);
    // importing is the user's own act — the doc starts with no "changes"
    await saveBaseline(docs.root, rel, body.markdown);
    hub.broadcast({ type: "doc:changed", path: rel, hash: hashOf(body.markdown), source: "external" });
    return c.json({ path: rel }, 201);
  });

  // Read-only raw files so relative image paths in documents render.
  app.get("/api/file", async (c) => {
    const relPath = c.req.query("path");
    if (!relPath) return c.json({ error: "path required" }, 400);
    const abs = await docs.resolveReal(relPath); // traversal + symlink guard
    const ext = path.extname(abs).toLowerCase();
    if (!(ext in IMAGE_MIME)) return c.json({ error: "unsupported file type" }, 415);
    const data = await fs.readFile(abs);
    return c.body(new Uint8Array(data), 200, {
      "content-type": IMAGE_MIME[ext],
      "cache-control": "no-cache",
    });
  });

  app.get("/api/comments", async (c) => {
    const relPath = c.req.query("path");
    if (!relPath) return c.json({ error: "path required" }, 400);
    guardPath(relPath);
    return c.json(await loadSidecar(docs.root, relPath));
  });

  app.post("/api/comments", async (c) => {
    const body = createCommentSchema.parse(await c.req.json());
    guardPath(body.path);
    if (body.path === PROJECT_PATH && body.selector) {
      return c.json({ error: "project notes cannot be anchored" }, 400);
    }
    return withSidecarLock(body.path, async () => {
      const sidecar = await loadSidecar(docs.root, body.path);
      const now = new Date().toISOString();
      const annotation: Annotation = {
        id: randomUUID().slice(0, 12),
        created: now,
        modified: now,
        body: { type: "TextualBody", value: body.body },
        target: body.selector
          ? {
              selector: [
                { type: "TextQuoteSelector", ...body.selector.quote },
                { type: "TextPositionSelector", ...body.selector.position },
              ],
            }
          : null,
        status: "open",
        resolution: null,
      };
      sidecar.annotations.push(annotation);
      if (body.path !== PROJECT_PATH && body.selector) {
        // only certify position hints when the selector was computed against
        // the content currently on disk
        const { hash } = await docs.read(body.path);
        if (body.baseHash === hash) sidecar.docHash = hash;
        else if (sidecar.docHash === hash) sidecar.docHash = "";
      }
      await saveSidecar(docs.root, body.path, sidecar);
      hub.broadcast({ type: "comments:changed", path: body.path });
      return c.json(annotation, 201);
    });
  });

  app.patch("/api/comments/:id", async (c) => {
    const id = c.req.param("id");
    const body = patchCommentSchema.parse(await c.req.json());
    guardPath(body.path);
    if (body.reply) {
      const annotation = await addAuthorReply(docs, hub, {
        path: body.path,
        id,
        text: body.reply,
      });
      return c.json(annotation);
    }
    return withSidecarLock(body.path, async () => {
      const sidecar = await loadSidecar(docs.root, body.path);
      const annotation = sidecar.annotations.find((a) => a.id === id);
      if (!annotation) return c.json({ error: "comment not found" }, 404);
      if (body.body !== undefined) annotation.body.value = body.body;
      if (body.editReply) {
        const target = annotation.replies?.[body.editReply.index];
        if (!target) return c.json({ error: "reply not found" }, 404);
        if (target.by !== "author") {
          return c.json({ error: "only your own replies can be edited" }, 400);
        }
        target.text = body.editReply.text;
      }
      if (body.status === "resolved") {
        const acceptingProposal = annotation.status === "addressed";
        annotation.status = "resolved";
        if (!acceptingProposal) {
          // author closing a comment themselves is not a Claude resolution —
          // only record one when there's an actual note to attribute.
          // (Accepting an "addressed" proposal keeps Claude's note instead.)
          annotation.resolution = body.resolutionNote
            ? { action: "resolved", note: body.resolutionNote }
            : null;
        }
      } else if (body.status === "open") {
        const wasClosed = annotation.status === "resolved" || annotation.status === "addressed";
        annotation.status = "open";
        if (annotation.resolution) {
          // rejected/reopened proposals become thread history, not lost notes
          annotation.replies = annotation.replies ?? [];
          annotation.replies.push({
            by: "claude",
            text: annotation.resolution.note,
            at: annotation.modified,
            action: annotation.resolution.action,
          });
          annotation.resolution = null;
        }
        if (wasClosed && annotation.target && body.path !== PROJECT_PATH) {
          // reanchor passes skip resolved/addressed comments while advancing
          // docHash, so a reopened comment's position hints may be falsely
          // certified
          const { markdown } = await docs.read(body.path);
          reanchorAnnotation(markdownToPlainText(markdown), annotation);
        }
      }
      if (body.selector) {
        annotation.target = {
          selector: [
            { type: "TextQuoteSelector", ...body.selector.quote },
            { type: "TextPositionSelector", ...body.selector.position },
          ],
        };
        annotation.status = "open";
      }
      touchAnnotation(annotation);
      await saveSidecar(docs.root, body.path, sidecar);
      hub.broadcast({ type: "comments:changed", path: body.path });
      return c.json(annotation);
    });
  });

  app.delete("/api/comments/:id", async (c) => {
    const id = c.req.param("id");
    const relPath = c.req.query("path");
    if (!relPath) return c.json({ error: "path required" }, 400);
    guardPath(relPath);
    return withSidecarLock(relPath, async () => {
      const sidecar = await loadSidecar(docs.root, relPath);
      const before = sidecar.annotations.length;
      sidecar.annotations = sidecar.annotations.filter((a) => a.id !== id);
      if (sidecar.annotations.length === before) return c.json({ error: "comment not found" }, 404);
      await saveSidecar(docs.root, relPath, sidecar);
      hub.broadcast({ type: "comments:changed", path: relPath });
      return c.json({ ok: true });
    });
  });

  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      const unsubscribe = hub.subscribe((event) => {
        stream.writeSSE({ data: JSON.stringify(event) }).catch(() => {});
      });
      stream.onAbort(unsubscribe);
      while (!stream.aborted) {
        await stream.writeSSE({ event: "ping", data: "" }).catch(() => {});
        await stream.sleep(15000);
      }
    }),
  );

  return app;
}
