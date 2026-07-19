import search from "approx-string-match";
import type { Annotation, TextQuoteSelector } from "./types.ts";

export interface AnchorResult {
  start: number;
  end: number;
  method: "position" | "exact" | "fuzzy";
}

const CONTEXT_LEN = 32;

// Cross-tier arbitration: an exact hit whose context agrees on at least this
// many chars is trusted outright. Below that, a fuzzy candidate may compete —
// but only wins with strong context of its own plus a clear score margin, so
// the default (exact wins) holds whenever the evidence is ambiguous.
const EXACT_TRUST_CONTEXT = 8;
const STRONG_CONTEXT = 16;
const DIVERT_MARGIN = 8;
// One fuzzy error costs the same as this many chars of context agreement.
const ERROR_COST = 4;
// Extra fuzzy-search passes with prior matches masked out (see fuzzyCandidates).
const FUZZY_ROUNDS = 3;

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

interface Candidate {
  start: number;
  end: number;
  errors: number;
}

/** True if index i falls between the two halves of a surrogate pair. */
function splitsSurrogatePair(text: string, i: number): boolean {
  if (i <= 0 || i >= text.length) return false;
  const hi = text.charCodeAt(i - 1);
  const lo = text.charCodeAt(i);
  return hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff;
}

/**
 * approx-string-match only ever returns matches at the globally minimal error
 * count, so a lightly-garbled decoy can eclipse the true site when the true
 * site carries one more error but perfect context. Re-run the search with
 * prior matches masked out so next-best candidates surface too, letting
 * pickBest weigh errors against context agreement.
 */
function fuzzyCandidates(plainText: string, exact: string, maxErrors: number): Candidate[] {
  const out: Candidate[] = [];
  let hay = plainText;
  for (let round = 0; round < FUZZY_ROUNDS; round++) {
    const matches = search(hay, exact, maxErrors);
    if (matches.length === 0) break;
    for (const m of matches) {
      // approx-string-match can return degenerate matches for short quotes;
      // require the match to retain most of the quote
      if (m.end - m.start >= exact.length * 0.5) {
        // never split a surrogate pair: snap boundaries outward to code points
        let start = m.start;
        let end = m.end;
        while (splitsSurrogatePair(plainText, start)) start--;
        while (splitsSurrogatePair(plainText, end)) end++;
        out.push({ start, end, errors: m.errors });
      }
      // mask the span either way so the next round surfaces new candidates
      hay = hay.slice(0, m.start) + "\u0000".repeat(m.end - m.start) + hay.slice(m.end);
    }
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
 *
 * Tiers 2 and 3 are not strictly sequential: an exact hit with poor context
 * agreement may be a verbatim copy of the old wording elsewhere in the doc
 * (common in review notes), so the fuzzy tier then competes for the
 * lightly-edited true site — but it only wins with decisively stronger
 * context evidence; when in doubt, exact wins.
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
    candidates: Candidate[],
  ): { start: number; end: number; context: number; score: number } | null => {
    let best: { start: number; end: number; context: number; score: number } | null = null;
    for (const c of candidates) {
      const context = contextScore(plainText, c.start, c.end, quote);
      // errors trade off against context agreement at a fixed exchange rate
      let score = (context - c.errors * ERROR_COST) * 1000;
      // tie-break: prefer candidates near the stale position hint
      score -= Math.abs(c.start - position.start) / Math.max(plainText.length, 1);
      if (!best || score > best.score) best = { start: c.start, end: c.end, context, score };
    }
    return best;
  };

  const exactHits = findAllExact(plainText, exact).map((s) => ({
    start: s,
    end: s + exact.length,
    errors: 0,
  }));
  const bestExact = pickBest(exactHits);

  // An exact hit with decent context agreement (or all the context there is,
  // for quotes near a doc edge) wins outright.
  const contextAvailable = quote.prefix.length + quote.suffix.length;
  if (bestExact && bestExact.context >= Math.min(EXACT_TRUST_CONTEXT, contextAvailable)) {
    return { start: bestExact.start, end: bestExact.end, method: "exact" };
  }

  // short quotes get a tight budget — a 4-char quote with 4 allowed errors
  // would "match" almost anywhere
  const maxErrors =
    exact.length <= 8 ? 1 : Math.min(Math.max(4, Math.ceil(exact.length * 0.2)), 32);
  const bestFuzzy = pickBest(fuzzyCandidates(plainText, exact, maxErrors));

  if (bestExact) {
    // conservative: exact still wins unless the fuzzy candidate carries both
    // strong absolute context and a decisive score margin
    if (
      bestFuzzy &&
      bestFuzzy.context >= Math.min(STRONG_CONTEXT, contextAvailable) &&
      bestFuzzy.score >= bestExact.score + DIVERT_MARGIN * 1000
    ) {
      return { start: bestFuzzy.start, end: bestFuzzy.end, method: "fuzzy" };
    }
    return { start: bestExact.start, end: bestExact.end, method: "exact" };
  }
  return bestFuzzy ? { start: bestFuzzy.start, end: bestFuzzy.end, method: "fuzzy" } : null;
}
