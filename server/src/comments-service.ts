import { markdownToPlainText, PROJECT_PATH } from "@redline/shared";
import type { Annotation, Reply, ResolutionAction } from "@redline/shared";
import { reanchorAnnotation } from "./anchoring.ts";
import { DocStore } from "./docs.ts";
import { EventHub } from "./events.ts";
import { loadSidecar, saveSidecar, touchAnnotation, withSidecarLock } from "./sidecar.ts";
import { listMarkdownFiles } from "./tree.ts";

export class NotFoundError extends Error {}

export interface OpenComment {
  id: string;
  /** "__project__" means the note applies to the whole project */
  path: string;
  status: "open" | "orphaned";
  /** null quote = unanchored note (whole document / whole project) */
  quote: string | null;
  prefix: string | null;
  suffix: string | null;
  comment: string;
  /** conversation so far: prior claude resolutions and author replies */
  thread: Reply[];
  /** rarely set: proposals normally live on "addressed" comments (not listed
   *  here) and fold into the thread when the author rejects them */
  lastResolution: { action: ResolutionAction; note: string } | null;
}

function guardPath(docs: DocStore, relPath: string): string {
  // canonicalized so aliases ('./a.md') hit the same sidecar and lock key
  return relPath === PROJECT_PATH ? relPath : docs.canonical(relPath);
}

/** Open + orphaned comments (incl. document and project notes). */
export async function listOpenComments(docs: DocStore, relPath?: string): Promise<OpenComment[]> {
  const paths = relPath
    ? [guardPath(docs, relPath)]
    : [PROJECT_PATH, ...(await listMarkdownFiles(docs.root)).map((e) => e.path)];
  const out: OpenComment[] = [];
  for (const p of paths) {
    const sidecar = await loadSidecar(docs.root, p);
    for (const a of sidecar.annotations) {
      // "addressed" is deliberately excluded: those proposals await the
      // author's verdict, not further work from Claude
      if (a.status !== "open" && a.status !== "orphaned") continue;
      out.push({
        id: a.id,
        path: p,
        status: a.status,
        quote: a.target?.selector[0].exact ?? null,
        prefix: a.target?.selector[0].prefix ?? null,
        suffix: a.target?.selector[0].suffix ?? null,
        comment: a.body.value,
        thread: a.replies ?? [],
        lastResolution: a.resolution,
      });
    }
  }
  return out;
}

export async function resolveComment(
  docs: DocStore,
  hub: EventHub,
  args: { path: string; id: string; action: ResolutionAction; note: string },
): Promise<Annotation> {
  const relPath = guardPath(docs, args.path);
  return withSidecarLock(relPath, async () => {
    const sidecar = await loadSidecar(docs.root, relPath);
    const annotation = sidecar.annotations.find((a) => a.id === args.id);
    if (!annotation) throw new NotFoundError(`comment not found: ${args.id} in ${relPath}`);
    // the author's close is final — a stale resolve (author accepted while
    // Claude was still working) must not reopen their verdict
    if (annotation.status === "resolved") {
      throw new Error(
        `comment ${args.id} was already resolved by the author; nothing to do. ` +
          `Run list_comments for the current queue.`,
      );
    }
    // Claude proposes, the author disposes: both resolve and decline land in
    // "addressed" — the note stays visible in the UI until the author accepts
    // (→ resolved) or rejects with a reply (→ open).
    annotation.status = "addressed";
    annotation.resolution = { action: args.action, note: args.note };
    touchAnnotation(annotation);
    await saveSidecar(docs.root, relPath, sidecar);
    hub.broadcast({ type: "comments:changed", path: relPath });
    return annotation;
  });
}

/**
 * Author replies to a comment: any prior claude resolution folds into the
 * thread, the reply is appended, and the comment reopens so Claude sees it
 * (with full history) on the next pass. Reopening re-anchors from the quote —
 * position hints on a previously-resolved comment may be stale-certified.
 */
export async function addAuthorReply(
  docs: DocStore,
  hub: EventHub,
  args: { path: string; id: string; text: string },
): Promise<Annotation> {
  const relPath = guardPath(docs, args.path);
  return withSidecarLock(relPath, async () => {
    const sidecar = await loadSidecar(docs.root, relPath);
    const annotation = sidecar.annotations.find((a) => a.id === args.id);
    if (!annotation) throw new NotFoundError(`comment not found: ${args.id} in ${relPath}`);
    const wasClosed = annotation.status === "resolved" || annotation.status === "addressed";
    const now = new Date().toISOString();
    annotation.replies = annotation.replies ?? [];
    if (annotation.resolution) {
      annotation.replies.push({
        by: "claude",
        text: annotation.resolution.note,
        at: annotation.modified,
        action: annotation.resolution.action,
      });
      annotation.resolution = null;
    }
    annotation.replies.push({ by: "author", text: args.text, at: now });
    if (wasClosed) annotation.status = "open";
    if (wasClosed && annotation.target && relPath !== PROJECT_PATH) {
      const { markdown } = await docs.read(relPath);
      reanchorAnnotation(markdownToPlainText(markdown), annotation);
    }
    touchAnnotation(annotation);
    await saveSidecar(docs.root, relPath, sidecar);
    hub.broadcast({ type: "comments:changed", path: relPath });
    return annotation;
  });
}
