import { markdownToPlainText, reanchorAnnotations, snapshotPriorQuotes } from "@redline/shared";
import { DocStore, hashOf } from "./docs.ts";
import { EventHub } from "./events.ts";
import { loadSidecar, saveSidecar, withSidecarLock } from "./sidecar.ts";

export { reanchorAnnotation } from "@redline/shared";

/**
 * Re-anchor all non-resolved annotations for a document against its current
 * content on disk. Persistence wrapper around the shared reanchorAnnotations
 * core. Returns the number of orphans.
 */
export async function reanchorFile(
  docs: DocStore,
  relPath: string,
  hub: EventHub | null,
  clientAnchors?: Array<{ id: string; start: number; end: number }>,
  opts: { snapshotPrior?: boolean } = {},
): Promise<number> {
  return withSidecarLock(relPath, async () => {
    const sidecar = await loadSidecar(docs.root, relPath);
    if (sidecar.annotations.length === 0) return 0;

    // the pre-revision text, if the store still has it — must be captured
    // before the read below replaces it with the current content
    const prior = docs.lastSeen(relPath);
    const { markdown, hash } = await docs.read(relPath);
    if (sidecar.docHash === hash && !clientAnchors) return 0; // nothing moved

    // external (agent) revisions preserve each comment's pre-revision passage
    // for old-vs-new review; the author's own editor saves must not
    if (opts.snapshotPrior) snapshotPriorQuotes(sidecar);
    // a prior certified against the sidecar's docHash unlocks diff-based
    // span mapping, which survives rewrites the quote ladder cannot find
    const priorPlain =
      prior !== undefined && hashOf(prior) === sidecar.docHash ? markdownToPlainText(prior) : null;
    const orphans = reanchorAnnotations(
      sidecar,
      markdownToPlainText(markdown),
      hash,
      clientAnchors,
      priorPlain,
    );
    await saveSidecar(docs.root, relPath, sidecar);
    hub?.broadcast({ type: "comments:changed", path: relPath });
    return orphans;
  });
}
