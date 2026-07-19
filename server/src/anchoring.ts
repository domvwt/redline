import { makeQuoteSelector, markdownToPlainText, resolveAnchor } from "@redline/shared";
import type { Annotation } from "@redline/shared";
import { DocStore } from "./docs.ts";
import { EventHub } from "./events.ts";
import { loadSidecar, saveSidecar, touchAnnotation, withSidecarLock } from "./sidecar.ts";

/**
 * Re-anchor all non-resolved annotations for a document against its current
 * content. A client-provided offset (from the editor's live position mapping)
 * is trusted only when it reproduces the annotation's existing quote — any
 * divergence (client/server plain-text drift, edits inside the passage) falls
 * back to the anchor ladder, which works from the stored quote+context.
 * Returns the number of orphans.
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

    const plain = markdownToPlainText(markdown);
    const byId = new Map((clientAnchors ?? []).map((c) => [c.id, c]));
    let orphans = 0;

    for (const a of sidecar.annotations) {
      // "addressed" is frozen like "resolved": demoting a pending proposal to
      // orphaned would both hide the awaiting-verdict state and put it back in
      // Claude's queue. It re-anchors when the author's rejection reopens it.
      if (a.status === "resolved" || a.status === "addressed" || !a.target) continue;
      const client = byId.get(a.id);
      let start: number | null = null;
      let end: number | null = null;

      if (
        client &&
        client.start >= 0 &&
        client.start < client.end &&
        client.end <= plain.length &&
        plain.slice(client.start, client.end) === a.target.selector[0].exact
      ) {
        start = client.start;
        end = client.end;
      } else {
        const result = resolveAnchor(plain, a);
        if (result) {
          start = result.start;
          end = result.end;
        }
      }

      if (start !== null && end !== null) {
        a.target.selector[0] = makeQuoteSelector(plain, start, end);
        a.target.selector[1] = { type: "TextPositionSelector", start, end };
        if (a.status === "orphaned") a.status = "open";
      } else {
        if (a.status !== "orphaned") a.status = "orphaned";
        orphans++;
      }
      touchAnnotation(a);
    }

    sidecar.docHash = hash;
    await saveSidecar(docs.root, relPath, sidecar);
    hub?.broadcast({ type: "comments:changed", path: relPath });
    return orphans;
  });
}

/**
 * Re-anchor a single annotation against the current document, ignoring stale
 * position hints. Used when a resolved comment reopens: reanchor passes skip
 * resolved annotations while still advancing docHash, so a reopened comment's
 * positions may be falsely certified until this runs. Call within the
 * sidecar lock; mutates the annotation in place.
 */
export function reanchorAnnotation(plain: string, annotation: Annotation): void {
  if (!annotation.target) return;
  const result = resolveAnchor(plain, annotation);
  if (result) {
    annotation.target.selector[0] = makeQuoteSelector(plain, result.start, result.end);
    annotation.target.selector[1] = {
      type: "TextPositionSelector",
      start: result.start,
      end: result.end,
    };
    if (annotation.status === "orphaned") annotation.status = "open";
  } else {
    annotation.status = "orphaned";
  }
}
