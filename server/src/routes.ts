import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  applyAuthorPatch,
  certifyPositionHints,
  markdownToPlainText,
  newAnnotation,
  PatchError,
  PROJECT_PATH,
} from "@redline/shared";
import { reanchorAnnotation, reanchorFile } from "./anchoring.ts";
import { addAuthorReply, NotFoundError } from "./comments-service.ts";
import { DocStore, hashOf, PathError } from "./docs.ts";
import { EventHub } from "./events.ts";
import { loadBaseline, saveBaseline } from "./reviewed.ts";
import { loadSidecar, saveSidecar, withSidecarLock } from "./sidecar.ts";
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

  // DNS-rebinding guard: the loopback bind stops direct remote connections,
  // but a hostile page whose DNS rebinds to 127.0.0.1 would be same-origin
  // with every route. The request URL's host comes from the Host header.
  app.use("*", async (c, next) => {
    const host = new URL(c.req.url).hostname;
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]") {
      return c.json({ error: "forbidden host" }, 403);
    }
    return next();
  });

  // canonicalized so aliases ('./a.md') hit the same sidecar and lock key
  const guardPath = (relPath: string): string =>
    relPath === PROJECT_PATH ? relPath : docs.canonical(relPath);

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
      // an SVG is an active document when navigated to; sandboxing the
      // response keeps its scripts out of the daemon origin (<img> rendering
      // is unaffected — image fetches never execute the document)
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox",
    });
  });

  app.get("/api/comments", async (c) => {
    const relPath = c.req.query("path");
    if (!relPath) return c.json({ error: "path required" }, 400);
    return c.json(await loadSidecar(docs.root, guardPath(relPath)));
  });

  app.post("/api/comments", async (c) => {
    const body = createCommentSchema.parse(await c.req.json());
    const relPath = guardPath(body.path);
    if (relPath === PROJECT_PATH && body.selector) {
      return c.json({ error: "project notes cannot be anchored" }, 400);
    }
    if (relPath !== PROJECT_PATH && body.selector) {
      // siblings may carry stale position hints (doc edited while the daemon
      // was down); re-anchor them so the docHash certification below cannot
      // vouch for offsets never checked against the current content. Any
      // drift consumed here is an external revision — keep the pre-revision
      // passages the watcher pass would otherwise have snapshotted
      await reanchorFile(docs, relPath, hub, undefined, { snapshotPrior: true });
    }
    return withSidecarLock(relPath, async () => {
      const sidecar = await loadSidecar(docs.root, relPath);
      const annotation = newAnnotation(randomUUID().slice(0, 12), body.body, body.selector ?? null);
      sidecar.annotations.push(annotation);
      if (relPath !== PROJECT_PATH && body.selector) {
        // only certify position hints when the selector was computed against
        // the content currently on disk
        const { hash } = await docs.read(relPath);
        certifyPositionHints(sidecar, hash, body.baseHash);
      }
      await saveSidecar(docs.root, relPath, sidecar);
      hub.broadcast({ type: "comments:changed", path: relPath });
      return c.json(annotation, 201);
    });
  });

  app.patch("/api/comments/:id", async (c) => {
    const id = c.req.param("id");
    const body = patchCommentSchema.parse(await c.req.json());
    const relPath = guardPath(body.path);
    if (body.reply) {
      const annotation = await addAuthorReply(docs, hub, {
        path: relPath,
        id,
        text: body.reply,
      });
      return c.json(annotation);
    }
    return withSidecarLock(relPath, async () => {
      const sidecar = await loadSidecar(docs.root, relPath);
      const annotation = sidecar.annotations.find((a) => a.id === id);
      if (!annotation) return c.json({ error: "comment not found" }, 404);
      let needsReanchor: boolean;
      try {
        needsReanchor = applyAuthorPatch(annotation, body).reanchor;
      } catch (err) {
        if (err instanceof PatchError) {
          return c.json({ error: err.message }, err.message === "reply not found" ? 404 : 400);
        }
        throw err;
      }
      if (needsReanchor && relPath !== PROJECT_PATH) {
        const { markdown } = await docs.read(relPath);
        reanchorAnnotation(markdownToPlainText(markdown), annotation);
      }
      await saveSidecar(docs.root, relPath, sidecar);
      hub.broadcast({ type: "comments:changed", path: relPath });
      return c.json(annotation);
    });
  });

  app.delete("/api/comments/:id", async (c) => {
    const id = c.req.param("id");
    const rawPath = c.req.query("path");
    if (!rawPath) return c.json({ error: "path required" }, 400);
    const relPath = guardPath(rawPath);
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
