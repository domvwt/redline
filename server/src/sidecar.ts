import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Annotation, Sidecar } from "@redline/shared";
import { markOwnWrite } from "./own-writes.ts";

const quoteSelector = z.object({
  type: z.literal("TextQuoteSelector"),
  exact: z.string(),
  prefix: z.string(),
  suffix: z.string(),
});

const positionSelector = z.object({
  type: z.literal("TextPositionSelector"),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
});

const annotationSchema = z.object({
  id: z.string().min(1),
  created: z.string(),
  modified: z.string(),
  body: z.object({ type: z.literal("TextualBody"), value: z.string() }),
  target: z.object({ selector: z.tuple([quoteSelector, positionSelector]) }).nullable(),
  status: z.enum(["open", "addressed", "resolved", "orphaned"]),
  resolution: z
    .object({
      action: z.enum(["resolved", "declined"]),
      note: z.string(),
    })
    .nullable(),
  replies: z
    .array(
      z.object({
        by: z.enum(["author", "claude", "agent"]),
        text: z.string(),
        at: z.string(),
        action: z.enum(["resolved", "declined"]).optional(),
      }),
    )
    .optional(),
});

const sidecarSchema = z.object({
  version: z.literal(1),
  docPath: z.string().optional(),
  docHash: z.string(),
  annotations: z.array(annotationSchema),
});

function sidecarPath(root: string, relPath: string): string {
  return path.join(root, ".redline", "comments", relPath.replace(/[\\/]/g, "__") + ".json");
}

/** Atomic write: temp file + rename, so external readers never see a torn file. */
export async function atomicWrite(file: string, content: string): Promise<void> {
  const tmp = file + ".tmp-" + process.pid;
  await fs.writeFile(tmp, content, "utf8");
  markOwnWrite(file);
  await fs.rename(tmp, file);
}

/**
 * Per-sidecar mutation lock. Every load→mutate→save cycle in the daemon must
 * run through this, or concurrent writers (routes vs MCP vs watcher reanchor)
 * clobber each other's read-modify-write.
 */
const locks = new Map<string, Promise<unknown>>();

export function withSidecarLock<T>(relPath: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(relPath) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(
    relPath,
    next.catch(() => {}),
  );
  return next;
}

export async function loadSidecar(root: string, relPath: string): Promise<Sidecar> {
  const file = sidecarPath(root, relPath);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, docPath: relPath, docHash: "", annotations: [] };
    }
    throw err;
  }
  try {
    const sidecar = sidecarSchema.parse(JSON.parse(raw)) as Sidecar;
    sidecar.docPath = sidecar.docPath ?? relPath;
    migrateLegacyReplies(sidecar);
    return sidecar;
  } catch (err) {
    // A corrupt sidecar (interrupted external write, bad hand edit) must not
    // brick the whole tree/MCP listing: quarantine it and start fresh.
    console.error(`corrupt sidecar quarantined: ${file}`, err);
    await fs.rename(file, file + `.corrupt-${Date.now()}`).catch(() => {});
    return { version: 1, docPath: relPath, docHash: "", annotations: [] };
  }
}

export async function saveSidecar(root: string, relPath: string, sidecar: Sidecar): Promise<void> {
  const file = sidecarPath(root, relPath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  sidecar.docPath = relPath;
  await atomicWrite(file, JSON.stringify(sidecar, null, 2) + "\n");
}

/** Early sidecars embedded "[resolved] "/"[declined] " in claude reply text
 *  instead of the structured `action` field — lift it out on load. */
function migrateLegacyReplies(sidecar: Sidecar): void {
  for (const a of sidecar.annotations) {
    for (const r of a.replies ?? []) {
      if (r.by !== "claude" || r.action) continue;
      const m = r.text.match(/^\[(resolved|declined)\]\s*/);
      if (m) {
        r.action = m[1] as "resolved" | "declined";
        r.text = r.text.slice(m[0].length);
      }
    }
  }
}

export function touchAnnotation(a: Annotation): void {
  a.modified = new Date().toISOString();
}

/** Ensure `.redline/` is git-ignored when the docs root sits anywhere inside a
 *  repo (the root itself is often a docs/ subdirectory). */
export async function ensureGitignore(root: string): Promise<void> {
  let dir = path.resolve(root);
  let inRepo = false;
  for (let i = 0; i < 40; i++) {
    try {
      await fs.access(path.join(dir, ".git"));
      inRepo = true;
      break;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  if (!inRepo) return;
  // a .gitignore inside the served root covers .redline/ regardless of depth
  const gitignore = path.join(root, ".gitignore");
  let content = "";
  try {
    content = await fs.readFile(gitignore, "utf8");
  } catch {
    // no .gitignore yet
  }
  if (!content.split(/\r?\n/).some((line) => line.trim() === ".redline/")) {
    const next =
      content.length && !content.endsWith("\n") ? content + "\n.redline/\n" : content + ".redline/\n";
    await fs.writeFile(gitignore, next, "utf8");
  }
}
