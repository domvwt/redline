import { makeQuoteSelector, resolveAnchor } from "./anchor-core.ts";
import { createSpanMapper, type SpanMapper } from "./revision-map.ts";
import type { Annotation, ResolutionAction, Sidecar } from "./types.ts";
import { PROJECT_PATH } from "./types.ts";

/**
 * Storage-agnostic comment lifecycle logic, shared by the daemon (filesystem
 * sidecars) and the serverless web build (IndexedDB). Functions mutate the
 * passed objects; persistence, locking, and event broadcast stay with the
 * caller.
 */

export interface SelectorInput {
  quote: { exact: string; prefix: string; suffix: string };
  position: { start: number; end: number };
}

/** Author verdict on an "addressed" proposal is final; a stale agent resolve
 *  must not reopen it. */
export class LifecycleError extends Error {}

/** Invalid author patch (bad reply index, editing someone else's reply). */
export class PatchError extends Error {}

export function emptySidecar(docPath: string): Sidecar {
  return { version: 1, docPath, docHash: "", annotations: [] };
}

export function touchAnnotation(a: Annotation): void {
  a.modified = new Date().toISOString();
}

export function newAnnotation(
  id: string,
  body: string,
  selector: SelectorInput | null,
): Annotation {
  const now = new Date().toISOString();
  return {
    id,
    created: now,
    modified: now,
    body: { type: "TextualBody", value: body },
    target: selector
      ? {
          selector: [
            { type: "TextQuoteSelector", ...selector.quote },
            { type: "TextPositionSelector", ...selector.position },
          ],
        }
      : null,
    status: "open",
    resolution: null,
  };
}

/** Only certify position hints when the selector was computed against the
 *  current content; otherwise revoke a certification that no longer holds
 *  for the annotation just added. */
export function certifyPositionHints(
  sidecar: Sidecar,
  currentHash: string,
  baseHash: string | undefined,
): void {
  if (baseHash === currentHash) sidecar.docHash = currentHash;
  else if (sidecar.docHash === currentHash) sidecar.docHash = "";
}

/** Agent proposes, the author disposes: both resolve and decline land in
 *  "addressed" — the note stays visible until the author accepts (→ resolved)
 *  or rejects with a reply (→ open). */
export function proposeResolution(
  annotation: Annotation,
  action: ResolutionAction,
  note: string,
): void {
  if (annotation.status === "resolved") {
    throw new LifecycleError(
      `comment ${annotation.id} was already resolved by the author; nothing to do. ` +
        `Run list_comments for the current queue.`,
    );
  }
  // an orphaned comment's selector still shows the pre-revision wording — the
  // proposal freezes it (reanchor skips "addressed"), so record that the
  // passage is gone before the orphan state is hidden behind "addressed"
  if (annotation.status === "orphaned") annotation.anchorLost = true;
  else delete annotation.anchorLost;
  annotation.status = "addressed";
  annotation.resolution = { action, note };
  touchAnnotation(annotation);
}

/** A pending proposal becomes thread history instead of a lost note. */
export function foldResolutionIntoThread(annotation: Annotation): void {
  if (!annotation.resolution) return;
  annotation.replies = annotation.replies ?? [];
  annotation.replies.push({
    by: "claude",
    text: annotation.resolution.note,
    at: annotation.modified,
    action: annotation.resolution.action,
  });
  annotation.resolution = null;
}

/** The old-vs-new comparison a snapshot supported is over — the author acted
 *  on the comment (reopened it, or re-anchored it by hand), so the next agent
 *  pass must snapshot afresh rather than keep an ancient comparison point. */
function clearRevisionMarks(annotation: Annotation): void {
  annotation.priorQuote = null;
  delete annotation.anchorLost;
}

/**
 * Before an agent/external revision re-anchors a document's comments, keep
 * each workable comment's current passage so the author can compare old vs
 * new. First snapshot wins: an agent pass may write the file several times,
 * and the comparison must span the whole pass, not just its last write.
 * Returns whether anything was recorded (i.e. the sidecar needs saving).
 */
export function snapshotPriorQuotes(sidecar: Sidecar): boolean {
  let changed = false;
  for (const a of sidecar.annotations) {
    if ((a.status === "open" || a.status === "orphaned") && a.target && !a.priorQuote) {
      a.priorQuote = { ...a.target.selector[0] };
      changed = true;
    }
  }
  return changed;
}

/**
 * Author replies: any prior agent resolution folds into the thread, the reply
 * is appended, and a closed comment reopens so the agent sees it (with full
 * history) on the next pass. Returns whether the comment was closed — the
 * caller must re-anchor it then (position hints on a closed comment may be
 * stale-certified).
 */
export function authorReply(annotation: Annotation, text: string): { wasClosed: boolean } {
  const wasClosed = annotation.status === "resolved" || annotation.status === "addressed";
  foldResolutionIntoThread(annotation);
  annotation.replies = annotation.replies ?? [];
  annotation.replies.push({ by: "author", text, at: new Date().toISOString() });
  if (wasClosed) {
    annotation.status = "open";
    // even for a note-less self-resolve (nothing to fold): reopening ends
    // the old-vs-new comparison, whatever closed the comment
    clearRevisionMarks(annotation);
  }
  touchAnnotation(annotation);
  return { wasClosed };
}

export interface AuthorPatch {
  body?: string;
  status?: "open" | "resolved";
  resolutionNote?: string;
  editReply?: { index: number; text: string };
  selector?: SelectorInput;
}

/**
 * Author-side comment edits (everything PATCH supports except replies, which
 * go through authorReply). Returns whether the caller must re-anchor the
 * annotation against current content.
 */
export function applyAuthorPatch(
  annotation: Annotation,
  patch: AuthorPatch,
): { reanchor: boolean } {
  let reanchor = false;
  if (patch.body !== undefined) annotation.body.value = patch.body;
  if (patch.editReply) {
    const target = annotation.replies?.[patch.editReply.index];
    if (!target) throw new PatchError("reply not found");
    if (target.by !== "author") throw new PatchError("only your own replies can be edited");
    target.text = patch.editReply.text;
  }
  if (patch.status === "resolved") {
    const acceptingProposal = annotation.status === "addressed";
    annotation.status = "resolved";
    if (!acceptingProposal) {
      // author closing a comment themselves is not an agent resolution —
      // only record one when there's an actual note to attribute.
      // (Accepting an "addressed" proposal keeps the agent's note instead.)
      annotation.resolution = patch.resolutionNote
        ? { action: "resolved", note: patch.resolutionNote }
        : null;
    }
  } else if (patch.status === "open") {
    const wasClosed = annotation.status === "resolved" || annotation.status === "addressed";
    annotation.status = "open";
    foldResolutionIntoThread(annotation);
    if (wasClosed) clearRevisionMarks(annotation);
    // reanchor passes skip resolved/addressed comments while advancing
    // docHash, so a reopened comment's position hints may be falsely certified
    if (wasClosed && annotation.target) reanchor = true;
  }
  if (patch.selector) {
    annotation.target = {
      selector: [
        { type: "TextQuoteSelector", ...patch.selector.quote },
        { type: "TextPositionSelector", ...patch.selector.position },
      ],
    };
    // a hand-placed anchor is the author's own act — a was/now block would
    // misattribute it to the agent
    clearRevisionMarks(annotation);
    annotation.status = "open";
  }
  touchAnnotation(annotation);
  return { reanchor };
}

/** Re-anchor a single annotation against current plain text, ignoring stale
 *  position hints. Mutates in place. */
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

/**
 * Re-anchor all non-closed annotations against the document's current plain
 * text and certify the sidecar at `hash`. A client-provided offset (from the
 * editor's live position mapping) is trusted only when it reproduces the
 * annotation's existing quote — any divergence falls back to the anchor
 * ladder, which works from the stored quote+context. Returns the orphan count.
 *
 * When the caller knows the exact text the stored positions refer to (it must
 * verify hashOf(priorMarkdown) === sidecar.docHash before passing its plain
 * text as `priorPlain`), a diff of old vs new maps each span to whatever
 * replaced it. That tier runs only where the quote-search ladder fails: while
 * the quote's text survives anywhere (light edit, verbatim move), the ladder's
 * context-scored search is authoritative — a word diff aligns on shared
 * stopwords, so it would misattribute a moved passage to whatever landed in
 * its old spot. The mapper rescues what the ladder would orphan: full
 * rephrasings ("my name is" → "I am called"). Spans it rejects — deleted
 * outright, absorbed into a whole-document rewrite, or too costly to diff —
 * stay orphaned as before, so nothing that anchored previously regresses.
 */
export function reanchorAnnotations(
  sidecar: Sidecar,
  plain: string,
  hash: string,
  clientAnchors?: Array<{ id: string; start: number; end: number }>,
  priorPlain?: string | null,
): number {
  const byId = new Map((clientAnchors ?? []).map((c) => [c.id, c]));
  let mapSpan: SpanMapper | null = null;
  const mapper = (): SpanMapper => (mapSpan ??= createSpanMapper(priorPlain!, plain));
  let orphans = 0;
  for (const a of sidecar.annotations) {
    // "addressed" is frozen like "resolved": demoting a pending proposal to
    // orphaned would both hide the awaiting-verdict state and put it back in
    // the agent's queue. It re-anchors when the author's rejection reopens it.
    if (a.status === "resolved" || a.status === "addressed" || !a.target) continue;
    const client = byId.get(a.id);
    const [quote, position] = a.target.selector;
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
      } else if (
        // rescue tier: the quote's text is gone, so map its stored span
        // through the revision diff to whatever replaced it. The certified-
        // prior gate covers the sidecar, not this annotation: its own
        // positions may still predate the prior text (e.g. reopened after
        // being skipped as "addressed"), so require they reproduce the quote.
        priorPlain != null &&
        priorPlain.slice(position.start, position.end) === quote.exact
      ) {
        const mapped = mapper()(position.start, position.end);
        if (mapped) {
          start = mapped.start;
          end = mapped.end;
        }
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
  return orphans;
}

/** Comments a handoff/agent pass should work on: open + orphaned, with the
 *  quote and thread context an external assistant needs. */
export function openCommentsOf(sidecar: Sidecar, path: string) {
  return sidecar.annotations
    .filter((a) => a.status === "open" || a.status === "orphaned")
    .map((a) => ({
      id: a.id,
      path,
      status: a.status as "open" | "orphaned",
      quote: a.target?.selector[0].exact ?? null,
      prefix: a.target?.selector[0].prefix ?? null,
      suffix: a.target?.selector[0].suffix ?? null,
      comment: a.body.value,
      thread: a.replies ?? [],
      lastResolution: a.resolution,
    }));
}

export { PROJECT_PATH };
