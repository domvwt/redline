import {
  authorReply,
  markdownToPlainText,
  openCommentsOf,
  PROJECT_PATH,
  proposeResolution,
  reanchorAnnotation,
} from "@redline/shared";
import type { Annotation, Reply, ResolutionAction } from "@redline/shared";
import { reanchorFile } from "./anchoring.ts";
import { DocStore } from "./docs.ts";
import { EventHub } from "./events.ts";
import { loadSidecar, saveSidecar, withSidecarLock } from "./sidecar.ts";
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
    // "addressed" is deliberately excluded: those proposals await the
    // author's verdict, not further work from Claude
    out.push(...openCommentsOf(sidecar, p));
  }
  return out;
}

export async function resolveComment(
  docs: DocStore,
  hub: EventHub,
  args: { path: string; id: string; action: ResolutionAction; note: string },
): Promise<Annotation> {
  const relPath = guardPath(docs, args.path);
  // an agent routinely writes the revised file and resolves the comment in
  // the same breath, outrunning the watcher's debounce — re-anchor now
  // (keeping pre-revision passages) so the proposal freezes the revised
  // anchor and the author still gets the old-vs-new comparison
  if (relPath !== PROJECT_PATH) {
    await reanchorFile(docs, relPath, hub, undefined, { snapshotPrior: true });
  }
  return withSidecarLock(relPath, async () => {
    const sidecar = await loadSidecar(docs.root, relPath);
    const annotation = sidecar.annotations.find((a) => a.id === args.id);
    if (!annotation) throw new NotFoundError(`comment not found: ${args.id} in ${relPath}`);
    proposeResolution(annotation, args.action, args.note);
    await saveSidecar(docs.root, relPath, sidecar);
    hub.broadcast({ type: "comments:changed", path: relPath });
    return annotation;
  });
}

/** Author replies to a comment; closed comments reopen and re-anchor. */
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
    const { wasClosed } = authorReply(annotation, args.text);
    if (wasClosed && annotation.target && relPath !== PROJECT_PATH) {
      // position hints on a previously-closed comment may be stale-certified
      const { markdown } = await docs.read(relPath);
      reanchorAnnotation(markdownToPlainText(markdown), annotation);
    }
    await saveSidecar(docs.root, relPath, sidecar);
    hub.broadcast({ type: "comments:changed", path: relPath });
    return annotation;
  });
}
