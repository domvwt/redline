import search from "approx-string-match";
import type { Annotation, TextQuoteSelector } from "./types.ts";

export interface AnchorResult {
  start: number;
  end: number;
  method: "position" | "exact" | "fuzzy";
}

const CONTEXT_LEN = 32;

export function makeQuoteSelector(
  plainText: string,
  start: number,
  end: number,
): TextQuoteSelector {
  return {
    type: "TextQuoteSelector",
    exact: plainText.slice(start, end),
    prefix: plainText.slice(Math.max(0, start - CONTEXT_LEN), start),
    suffix: plainText.slice(end, end + CONTEXT_LEN),
  };
}

/** Score a candidate match position by agreement with prefix/suffix context. */
function contextScore(
  plainText: string,
  start: number,
  end: number,
  quote: TextQuoteSelector,
): number {
  let score = 0;
  const before = plainText.slice(Math.max(0, start - CONTEXT_LEN), start);
  const after = plainText.slice(end, end + CONTEXT_LEN);
  score += commonSuffixLen(before, quote.prefix);
  score += commonPrefixLen(after, quote.suffix);
  return score;
}

function commonPrefixLen(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

function commonSuffixLen(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

function findAllExact(haystack: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    out.push(idx);
    idx = haystack.indexOf(needle, idx + 1);
  }
  return out;
}

/**
 * Resolve an annotation's anchor against the current plain text.
 *
 * Ladder:
 *  1. position hint (only if caller verified docHash matches)
 *  2. exact quote search, disambiguated by prefix/suffix context and
 *     proximity to the stale position hint
 *  3. fuzzy search (approx-string-match) with an error budget proportional
 *     to quote length, disambiguated the same way
 *  4. null -> caller marks the annotation orphaned
 */
export function resolveAnchor(
  plainText: string,
  annotation: Annotation,
  opts: { positionHintValid?: boolean } = {},
): AnchorResult | null {
  if (!annotation.target) return null; // unanchored note
  const [quote, position] = annotation.target.selector;
  const exact = quote.exact;
  if (!exact) return null;

  // A docHash-certified hint can still be stale if the plain-text extraction
  // rules themselves changed since it was stored (the hash covers the doc, not
  // the text domain) — so trust it only if it still reproduces the quote.
  if (opts.positionHintValid && plainText.slice(position.start, position.end) === exact) {
    return { start: position.start, end: position.end, method: "position" };
  }

  const pickBest = (
    candidates: Array<{ start: number; end: number }>,
    method: "exact" | "fuzzy",
  ): AnchorResult | null => {
    if (candidates.length === 0) return null;
    let best = candidates[0];
    let bestScore = -Infinity;
    for (const c of candidates) {
      let score = contextScore(plainText, c.start, c.end, quote) * 1000;
      // tie-break: prefer candidates near the stale position hint
      score -= Math.abs(c.start - position.start) / Math.max(plainText.length, 1);
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    return { start: best.start, end: best.end, method };
  };

  const exactHits = findAllExact(plainText, exact).map((s) => ({
    start: s,
    end: s + exact.length,
  }));
  const exactResult = pickBest(exactHits, "exact");
  if (exactResult) return exactResult;

  // short quotes get a tight budget — a 4-char quote with 4 allowed errors
  // would "match" almost anywhere
  const maxErrors =
    exact.length <= 8 ? 1 : Math.min(Math.max(4, Math.ceil(exact.length * 0.2)), 32);
  const fuzzyHits = search(plainText, exact, maxErrors)
    // approx-string-match can return degenerate matches for short quotes;
    // require the match to retain most of the quote
    .filter((m) => m.end - m.start >= exact.length * 0.5)
    .map((m) => ({ start: m.start, end: m.end }));
  return pickBest(fuzzyHits, "fuzzy");
}
