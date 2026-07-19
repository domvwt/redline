import { markdownToPlainText, reanchorAnnotations } from "@redline/shared";
import { DocStore } from "./docs.ts";
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
): Promise<number> {
  return withSidecarLock(relPath, async () => {
    const sidecar = await loadSidecar(docs.root, relPath);
    if (sidecar.annotations.length === 0) return 0;

    const { markdown, hash } = await docs.read(relPath);
    if (sidecar.docHash === hash && !clientAnchors) return 0; // nothing moved

    const orphans = reanchorAnnotations(sidecar, markdownToPlainText(markdown), hash, clientAnchors);
    await saveSidecar(docs.root, relPath, sidecar);
    hub?.broadcast({ type: "comments:changed", path: relPath });
    return orphans;
  });
}
