import { diffWordsWithSpace } from "diff";

/**
 * Offset mapping across a known revision: when the caller has both the text a
 * set of positions refers to and the text that replaced it, a diff pins each
 * old span to whatever rewrote it — no searching, no error budget. This is
 * what lets a comment on "my name is" land on "I am called" when an agent
 * rephrases the sentence: quote-based anchoring (anchor-core) has nothing to
 * find, but the diff knows exactly which words replaced which.
 *
 * Only usable when the "before" text is certified (its hash matches the hash
 * the positions were anchored against) — callers gate on that.
 */

interface Region {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
  changed: boolean;
}

export type SpanMapper = (start: number, end: number) => { start: number; end: number } | null;

/** Myers diff is O(N·D); a whole-document rewrite of a large doc could stall
 *  the daemon's watcher or freeze the browser tab. Past this budget the
 *  mapper gives up and every span falls back to the caller's other tiers. */
const DIFF_TIMEOUT_MS = 1000;

/** A rewritten span may legitimately grow, but a span that balloons past this
 *  is a whole-document rewrite the diff couldn't align — anchoring a short
 *  comment to it would be noise, so the mapper reports failure instead. */
function maxMappedLength(oldLen: number): number {
  return oldLen * 4 + 64;
}

/**
 * Build a span mapper from the word-level diff of two plain texts. Returns a
 * function mapping an old [start, end) span to its new location:
 *  - a span inside unchanged text maps by offset arithmetic;
 *  - a span touching changed text stretches to cover the full replacement
 *    (so the was/now comparison shows the whole rewrite);
 *  - a span whose text was deleted with nothing in its place, or whose
 *    replacement fails the sanity bound, maps to null.
 */
export function createSpanMapper(oldText: string, newText: string): SpanMapper {
  const parts = diffWordsWithSpace(oldText, newText, { timeout: DIFF_TIMEOUT_MS });
  if (!parts) return () => null; // diff gave up within the time budget

  // fold the part list into alternating unchanged/changed regions; adjacent
  // removed+added runs (either order) merge into one replacement region
  const regions: Region[] = [];
  let o = 0;
  let n = 0;
  for (const part of parts) {
    const len = part.value.length;
    const last = regions[regions.length - 1];
    if (part.added) {
      if (last && last.changed && last.oldEnd === o && last.newEnd === n) last.newEnd = n + len;
      else regions.push({ oldStart: o, oldEnd: o, newStart: n, newEnd: n + len, changed: true });
      n += len;
    } else if (part.removed) {
      if (last && last.changed && last.oldEnd === o && last.newEnd === n) last.oldEnd = o + len;
      else regions.push({ oldStart: o, oldEnd: o + len, newStart: n, newEnd: n, changed: true });
      o += len;
    } else {
      regions.push({ oldStart: o, oldEnd: o + len, newStart: n, newEnd: n + len, changed: false });
      o += len;
      n += len;
    }
  }

  // A whole-paragraph rewrite still aligns on the bare spaces between words,
  // fragmenting what is really one replacement into changed regions separated
  // by one-space "unchanged" slivers — which would let a span map to arbitrary
  // text between two coincidentally-aligned spaces. Whitespace carries no
  // anchoring evidence, so fold whitespace-only gaps between changes into one
  // changed region; the size bound below then sees the rewrite's true extent.
  const folded: Region[] = [];
  for (let i = 0; i < regions.length; i++) {
    const r = regions[i];
    const prev = folded[folded.length - 1];
    if (!r.changed) {
      const isWhitespaceGap =
        oldText.slice(r.oldStart, r.oldEnd).trim() === "" &&
        prev?.changed &&
        regions[i + 1]?.changed;
      if (!isWhitespaceGap) {
        folded.push({ ...r });
        continue;
      }
    }
    if (prev?.changed) {
      prev.oldEnd = r.oldEnd;
      prev.newEnd = r.newEnd;
      prev.changed = true;
    } else {
      folded.push({ ...r, changed: true });
    }
  }

  return (start, end) => {
    if (start < 0 || end > oldText.length || start >= end) return null;

    // start: first region reaching past it — skips zero-width insertions at
    // the boundary, so text inserted exactly at the span start stays outside
    let mappedStart: number | null = null;
    for (const r of folded) {
      if (start < r.oldEnd) {
        mappedStart = r.changed ? r.newStart : r.newStart + (start - r.oldStart);
        break;
      }
    }

    // end (exclusive): last region starting before it, for the mirror reason
    let mappedEnd: number | null = null;
    for (let i = folded.length - 1; i >= 0; i--) {
      const r = folded[i];
      if (end > r.oldStart) {
        mappedEnd = r.changed ? r.newEnd : r.newStart + (end - r.oldStart);
        break;
      }
    }

    if (mappedStart === null || mappedEnd === null) return null;
    if (mappedEnd <= mappedStart) return null; // deleted outright, no replacement
    if (mappedEnd - mappedStart > maxMappedLength(end - start)) return null;
    if (newText.slice(mappedStart, mappedEnd).trim() === "") return null;
    return { start: mappedStart, end: mappedEnd };
  };
}
