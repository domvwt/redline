import { diffArrays } from "diff";
import { diffRegions, type Region } from "./revision-map.ts";

/**
 * One tracked change between two plain texts (the anchor domain). `block`
 * marks whole blocks added or removed — drawn as blocks, not as inline runs
 * spliced into a neighbour.
 */
export interface TrackedChange {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
  block: boolean;
  /** inside code, where whitespace carries meaning: a re-indent is a change */
  whitespace?: boolean;
}

/**
 * Where a text's blocks begin, from the renderer (which knows paragraphs
 * from soft-wrapped lines), and optionally what kind each is — see
 * markdownToPlainBlocks.
 */
export interface BlockLayout {
  blockStarts: number[];
  blockKinds?: string[];
}

interface Line {
  text: string;
  start: number;
  kind?: string;
}

/** Split text into blocks by `layout`; without one, every line is a block. */
function toBlocks(text: string, layout?: BlockLayout): Line[] {
  if (!text) return [];
  if (!layout) {
    const bounds = [0, ...[...text.matchAll(/\n/g)].map((m) => m.index + 1)];
    return bounds.map((start, k) => ({
      text: text.slice(start, (bounds[k + 1] ?? text.length + 1) - 1),
      start,
    }));
  }
  // blocks with no text share a start with the next; the later one, which
  // holds the text, names the kind
  const kindAt = new Map<number, string | undefined>([[0, undefined]]);
  layout.blockStarts.forEach((start, k) => {
    if (start < text.length) kindAt.set(start, layout.blockKinds?.[k]);
  });
  const bounds = [...kindAt.keys()].sort((x, y) => x - y);
  return bounds.map((start, k) => {
    let end = bounds[k + 1] ?? text.length;
    if (k + 1 < bounds.length && text[end - 1] === "\n") end--;
    return { text: text.slice(start, end), start, kind: kindAt.get(start) };
  });
}

/** blocks of different kinds never pair; unknown kinds pair with anything */
const sameKind = (x: Line, y: Line) => !x.kind || !y.kind || x.kind === y.kind;

/**
 * How much two blocks read as one, 0..1: the share of the longer block's
 * words the other also has — or, when one is mostly contained in the other
 * (a paragraph trimmed hard), half its own share. A bag-of-words overlap,
 * linear where a word diff would be quadratic.
 */
export function blockSimilarity(a: string, b: string): number {
  // punctuation is no evidence either way: "Tail." still shares "Tail"
  const words = (t: string) => t.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const wa = words(a);
  const wb = words(b);
  const size = (ws: string[]) => ws.reduce((n, w) => n + w.length, 0);
  const longest = Math.max(size(wa), size(wb));
  const shortest = Math.min(size(wa), size(wb));
  if (longest === 0) return 1;
  const counts = new Map<string, number>();
  for (const w of wa) counts.set(w, (counts.get(w) ?? 0) + 1);
  let common = 0;
  for (const w of wb) {
    const n = counts.get(w) ?? 0;
    if (n > 0) {
      counts.set(w, n - 1);
      common += w.length;
    }
  }
  const contained = Math.min(wa.length, wb.length) >= 3 ? common / shortest / 2 : 0;
  return Math.max(common / longest, contained);
}

/** shared letter pairs, 0..1 — for short cells, where words rarely survive */
function charSimilarity(a: string, b: string): number {
  const pairsOf = (t: string) => {
    const out = new Map<string, number>();
    const s = t.toLowerCase();
    for (let k = 0; k < s.length - 1; k++) out.set(s.slice(k, k + 2), (out.get(s.slice(k, k + 2)) ?? 0) + 1);
    return out;
  };
  const pa = pairsOf(a);
  const pb = pairsOf(b);
  let common = 0;
  for (const [p, n] of pb) common += Math.min(n, pa.get(p) ?? 0);
  const total = Math.max(a.length - 1, 0) + Math.max(b.length - 1, 0);
  return total ? (2 * common) / total : a === b ? 1 : 0;
}

/** a paragraph counts as "the same one, revised" past this overlap */
export const PAIR_THRESHOLD = 0.4;
/** shared words enough to align an unpaired rewrite with its original
 *  rather than with whatever block comes next */
export const ALIGN_EVIDENCE = 0.15;
/** how far ahead in the added lines a removed line looks for its revision */
const PAIR_WINDOW = 8;

/** unchanged slivers this short between two changes are coincidence
 *  ("the", "a", "of") — reading them as kept text shreds the rewrite */
function isSliver(text: string): boolean {
  const t = text.trim();
  return t === "" || (t.length <= 3 && !/\s/.test(t));
}

/** total diff time per call — block alignment and word diffs alike — so a
 *  huge rewrite stays bounded; past it, changed blocks show as whole-block
 *  swaps (unchanged ones still pair off and show nothing) */
const WORD_DIFF_BUDGET_MS = 250;

/** word-level changes inside one revised block, offsets absolute */
function lineChanges(oldLine: Line, newLine: Line, timeoutMs: number): TrackedChange[] {
  // code keeps its lines: diff it line by line, drawn inline (a code block
  // has no room for blocks), so a deleted line shows whole
  if (oldLine.kind === "code" && newLine.kind === "code") {
    // sharing what's left of the caller's time budget
    return trackChanges(oldLine.text, newLine.text, undefined, undefined, Date.now() + timeoutMs).map(
      (c) => ({
        oldStart: oldLine.start + c.oldStart,
        oldEnd: oldLine.start + c.oldEnd,
        newStart: newLine.start + c.newStart,
        newEnd: newLine.start + c.newEnd,
        block: false,
        whitespace: true,
      }),
    );
  }
  // soft wraps read as spaces (same length, so offsets hold): a re-wrapped
  // paragraph is not a changed one
  const o = oldLine.text.replace(/\n/g, " ");
  const n = newLine.text.replace(/\n/g, " ");
  if (o === n) return [];
  const regions = timeoutMs > 0 ? diffRegions(o, n, timeoutMs) : null;
  if (!regions) {
    return [
      {
        oldStart: oldLine.start,
        oldEnd: oldLine.start + oldLine.text.length,
        newStart: newLine.start,
        newEnd: newLine.start + newLine.text.length,
        block: true,
      },
    ];
  }
  const folded: Region[] = [];
  regions.forEach((r, i) => {
    const prev = folded[folded.length - 1];
    const sliver =
      !r.changed &&
      prev?.changed &&
      regions[i + 1]?.changed &&
      isSliver(o.slice(r.oldStart, r.oldEnd));
    if ((r.changed || sliver) && prev?.changed) {
      prev.oldEnd = r.oldEnd;
      prev.newEnd = r.newEnd;
    } else {
      folded.push({ ...r, changed: r.changed || !!sliver });
    }
  });
  return folded
    .filter((r) => r.changed)
    .map((r) => {
      // whitespace both sides share at an edge is kept text, not change
      let { oldStart, oldEnd, newStart, newEnd } = r;
      while (oldStart < oldEnd && newStart < newEnd && o[oldStart] === n[newStart] && /\s/.test(o[oldStart])) {
        oldStart++;
        newStart++;
      }
      while (oldEnd > oldStart && newEnd > newStart && o[oldEnd - 1] === n[newEnd - 1] && /\s/.test(o[oldEnd - 1])) {
        oldEnd--;
        newEnd--;
      }
      return {
        oldStart: oldLine.start + oldStart,
        oldEnd: oldLine.start + oldEnd,
        newStart: newLine.start + newStart,
        newEnd: newLine.start + newEnd,
        block: false,
      };
    });
}

/**
 * Tracked changes from `oldText` to `newText`, in order in both texts.
 * Blocks align first; within a run of changed blocks, a removed block pairs
 * with the added block it most resembles and the two are word-diffed.
 * Unpaired blocks are whole-block insertions or deletions — so a new
 * paragraph never borrows stray words from an unrelated deleted one.
 *
 * Pairing respects block kinds: a table cell never pairs with a paragraph,
 * and cells left over pair within their column by closest spelling — a
 * cell is its column, whatever its new text.
 *
 * Without layouts each line is a block. Unchanged text between changes is
 * identical in both texts, so offsets map across by arithmetic (see
 * mapFromBaseline).
 */
export function trackChanges(
  oldText: string,
  newText: string,
  oldBlocks?: BlockLayout,
  newBlocks?: BlockLayout,
  deadline = Date.now() + WORD_DIFF_BUDGET_MS,
): TrackedChange[] {
  const oldLines = toBlocks(oldText, oldBlocks);
  const newLines = toBlocks(newText, newBlocks);
  // past the budget, the whole text is one changed run: pairing below still
  // finds the unchanged blocks, cheaply
  const parts = diffArrays(
    oldLines.map((l) => l.text),
    newLines.map((l) => l.text),
    // half the budget, leaving the rest for word diffs
    { timeout: Math.max(1, (deadline - Date.now()) / 2) },
  ) ?? [
    { value: [], count: oldLines.length, removed: true, added: false },
    { value: [], count: newLines.length, added: true, removed: false },
  ];
  const out: TrackedChange[] = [];
  const oldAt = (i: number) => oldLines[i]?.start ?? oldText.length;
  const newAt = (j: number) => newLines[j]?.start ?? newText.length;

  let i = 0;
  let j = 0;
  let k = 0;
  while (k < parts.length) {
    if (!parts[k].added && !parts[k].removed) {
      i += parts[k].count ?? parts[k].value.length;
      j += parts[k].count ?? parts[k].value.length;
      k++;
      continue;
    }
    let removed = 0;
    let added = 0;
    for (; k < parts.length && (parts[k].added || parts[k].removed); k++) {
      const n = parts[k].count ?? parts[k].value.length;
      if (parts[k].added) added += n;
      else removed += n;
    }

    // pair each removed block with its closest revision, in order. An
    // identical block anywhere ahead is its own — the block diff may have
    // run out of time and left unchanged text in this run
    const exactAt = new Map<string, number[]>();
    for (let a = j + added - 1; a >= j; a--) {
      const list = exactAt.get(newLines[a].text) ?? [];
      list.push(a);
      exactAt.set(newLines[a].text, list);
    }
    const similar: Array<[number, number]> = [];
    let from = j;
    for (let r = i; r < i + removed; r++) {
      const same = exactAt.get(oldLines[r].text);
      while (same?.length && same[same.length - 1] < from) same.pop();
      if (same?.length && sameKind(oldLines[r], newLines[same[same.length - 1]])) {
        from = same.pop()! + 1;
        similar.push([r, from - 1]);
        continue;
      }
      // candidates best first; one a later removed block reads more like is
      // that block's real revision (a short deleted paragraph mustn't take a
      // revised one's place), so fall back to the next
      const candidates: Array<[number, number]> = [];
      for (let a = from; a < Math.min(j + added, from + PAIR_WINDOW); a++) {
        if (!sameKind(oldLines[r], newLines[a])) continue;
        const score = blockSimilarity(oldLines[r].text, newLines[a].text);
        if (score >= PAIR_THRESHOLD) candidates.push([a, score]);
      }
      candidates.sort((x, y) => y[1] - x[1]);
      // claimed: a later removed block scores higher against it AND has it
      // as its own top pick (a block that prefers another doesn't claim)
      const topPick = (q: number) => {
        let pick = -1;
        let pickScore = PAIR_THRESHOLD;
        for (let a = from; a < Math.min(j + added, from + PAIR_WINDOW); a++) {
          if (!sameKind(oldLines[q], newLines[a])) continue;
          const score = blockSimilarity(oldLines[q].text, newLines[a].text);
          if (score >= pickScore) [pick, pickScore] = [a, score];
        }
        return pick;
      };
      const claimed = ([a, score]: [number, number]) => {
        for (let q = r + 1; q < Math.min(i + removed, r + 1 + PAIR_WINDOW); q++) {
          if (
            sameKind(oldLines[q], newLines[a]) &&
            blockSimilarity(oldLines[q].text, newLines[a].text) > score &&
            topPick(q) === a
          ) {
            return true;
          }
        }
        return false;
      };
      // never fall back past a claimed block: pairing beyond it would strand
      // the block that claimed it
      let best = -1;
      let limit = Infinity;
      for (const c of candidates) {
        if (c[0] >= limit) continue;
        if (!claimed(c)) {
          best = c[0];
          break;
        }
        limit = c[0];
      }
      if (best !== -1) {
        similar.push([r, best]);
        from = best + 1;
      }
    }

    // between those pairs, a leftover table cell pairs with the closest
    // spelling in its own column — a cell is its column, whatever its text;
    // when whole rows went, the closest spelling says which survived
    const pairs: Array<[number, number]> = [];
    let gapR = i;
    let gapA = j;
    for (const pair of [...similar, [i + removed, j + added] as [number, number]]) {
      let r0 = gapR;
      for (let a = gapA; a < pair[1]; a++) {
        if (!newLines[a].kind?.startsWith("table")) continue;
        let best = -1;
        let bestScore = -1;
        for (let r = r0; r < pair[0]; r++) {
          if (oldLines[r].kind !== newLines[a].kind) continue;
          const score = charSimilarity(oldLines[r].text, newLines[a].text);
          if (score > bestScore) {
            best = r;
            bestScore = score;
          }
        }
        if (best === -1) continue;
        pairs.push([best, a]);
        r0 = best + 1;
      }
      if (pair[0] < i + removed) pairs.push(pair);
      gapR = pair[0] + 1;
      gapA = pair[1] + 1;
    }

    let r = i;
    let a = j;
    // unpaired removed and added blocks (no table among them) replace one
    // another. Blocks sharing real words with a same-kind block a little
    // further on pair first, in order; the rest pair in order between those,
    // so an unrelated deletion or insertion stands alone rather than between
    // a rewrite and its original. Each old block is drawn just above its new one
    const alignReplacements = (rTo: number, aTo: number) => {
      const evidence = (x: number, y: number) =>
        sameKind(oldLines[x], newLines[y]) ? blockSimilarity(oldLines[x].text, newLines[y].text) : 0;
      const anchors: Array<[number, number]> = [];
      let c = a;
      for (let x = r; x < rTo; x++) {
        let best = -1;
        let bestScore = ALIGN_EVIDENCE;
        for (let y = c; y < Math.min(aTo, c + PAIR_WINDOW); y++) {
          const sc = evidence(x, y);
          if (sc > bestScore) [best, bestScore] = [y, sc];
        }
        if (best !== -1) {
          anchors.push([x, best]);
          c = best + 1;
        }
      }
      const matched: Array<[number, number]> = [];
      let gr = r;
      let ga = a;
      for (const anchor of [...anchors, [rTo, aTo] as [number, number]]) {
        fillGap(gr, anchor[0], ga, anchor[1], matched);
        if (anchor[0] < rTo) matched.push(anchor);
        gr = anchor[0] + 1;
        ga = anchor[1] + 1;
      }
      for (const [x, y] of matched) {
        if (x > r) removeEach(r, x, newAt(a));
        if (y > a) out.push({ oldStart: oldAt(x), oldEnd: oldAt(x), newStart: newAt(a), newEnd: newAt(y), block: true });
        out.push({ oldStart: oldAt(x), oldEnd: oldAt(x + 1), newStart: newAt(y), newEnd: newAt(y), block: true });
        out.push({ oldStart: oldAt(x + 1), oldEnd: oldAt(x + 1), newStart: newAt(y), newEnd: newAt(y + 1), block: true });
        r = x + 1;
        a = y + 1;
      }
      if (aTo > a) out.push({ oldStart: oldAt(r), oldEnd: oldAt(r), newStart: newAt(a), newEnd: newAt(aTo), block: true });
      if (rTo > r) removeEach(r, rTo, newAt(aTo));
      r = rTo;
      a = aTo;
    };
    /**
     * Pairs within a gap between evidenced matches. Headings pair with
     * headings first, in order (a renamed heading, whatever was deleted or
     * added around it); the rest fill around them
     */
    const fillGap = (r0: number, r1: number, a0: number, a1: number, into: Array<[number, number]>) => {
      const headings: Array<[number, number]> = [];
      let cy = a0;
      for (let x = r0; x < r1; x++) {
        if (oldLines[x].kind !== "heading") continue;
        let y = cy;
        while (y < a1 && newLines[y].kind !== "heading") y++;
        if (y >= a1) break;
        headings.push([x, y]);
        cy = y + 1;
      }
      let gr = r0;
      let ga = a0;
      for (const h of [...headings, [r1, a1] as [number, number]]) {
        fillInOrder(gr, h[0], ga, h[1], into);
        if (h[0] < r1) into.push(h);
        gr = h[0] + 1;
        ga = h[1] + 1;
      }
    };
    /**
     * In order — but with more removed than added, each added block takes the
     * first removed block of its kind in reach (skipped ones stay deletions:
     * a rewrite next to a deleted paragraph), else the last (a list rewritten
     * as one paragraph keeps its struck items together above it)
     */
    const fillInOrder = (r0: number, r1: number, a0: number, a1: number, into: Array<[number, number]>) => {
      if (r1 <= r0 || a1 <= a0) return;
      if (r1 - r0 <= a1 - a0) {
        for (let k = 0; r0 + k < r1; k++) into.push([r0 + k, a0 + k]);
        return;
      }
      let cc = r0;
      for (let y = a0; y < a1; y++) {
        const last = r1 - (a1 - y);
        let pick = last;
        for (let x = cc; x <= last; x++) {
          if (sameKind(oldLines[x], newLines[y])) {
            pick = x;
            break;
          }
        }
        into.push([pick, y]);
        cc = pick + 1;
      }
    };
    /** each removed block its own change, all at one point in the new text */
    const removeEach = (from: number, to: number, at: number) => {
      for (let b = from; b < to; b++) {
        out.push({ oldStart: oldAt(b), oldEnd: oldAt(b + 1), newStart: at, newEnd: at, block: true });
      }
    };
    const flush = (rTo: number, aTo: number) => {
      // unpaired blocks replace one another in order; surplus removals sit
      // after the additions, where they fell in the flow. A block span runs to
      // the next block's start, taking its separator along; the last block
      // has none after it, so one-sided changes at the end take the one before
      const atEnd = rTo === oldLines.length && aTo === newLines.length;
      const takeBefore = (text: string, at: number) => (at > 0 && text[at - 1] === "\n" ? at - 1 : at);
      // only non-table blocks interleave as replacements: table cells stay
      // together as rows
      const isCell = (l: Line) => !!l.kind?.startsWith("table");
      const anyCell = (lines: Line[], from: number, to: number) => lines.slice(from, to).some(isCell);
      if (rTo > r && aTo > a && !anyCell(oldLines, r, rTo) && !anyCell(newLines, a, aTo)) {
        alignReplacements(rTo, aTo);
        return;
      }
      let mid = r;
      while (mid < rTo && mid - r < aTo - a && !isCell(oldLines[mid]) && !isCell(newLines[a + mid - r])) {
        mid++;
      }
      // each removed block is its own change — a table's cells stay together
      // as rows — so unrelated neighbours aren't one change
      const removeBlocks = (from: number, to: number, at: number, firstStart: number) => {
        for (let b = from; b < to; ) {
          let e = b + 1;
          const table = oldLines[b].kind?.startsWith("table");
          while (table && e < to && oldLines[e].kind?.startsWith("table")) e++;
          const oldStart = b === from ? firstStart : oldAt(b);
          out.push({ oldStart, oldEnd: oldAt(e), newStart: at, newEnd: at, block: true });
          b = e;
        }
      };
      // replacements interleave, each old block just above its new one
      for (let k = 0; r + k < mid; k++) {
        const at = newAt(a + k);
        out.push({ oldStart: oldAt(r + k), oldEnd: oldAt(r + k + 1), newStart: at, newEnd: at, block: true });
        const old = oldAt(r + k + 1);
        out.push({ oldStart: old, oldEnd: old, newStart: at, newEnd: newAt(a + k + 1), block: true });
      }
      const aMid = a + (mid - r);
      // with nothing interleaved (a table among them), the old blocks come
      // first, as tracked changes read: a removed row stays under its table
      // …unless the additions extend a table: removals first would land the
      // old block inside the new row
      const extendsTable =
        a > 0 && a < aTo && r < rTo && isCell(newLines[a]) && isCell(newLines[a - 1]) && !isCell(oldLines[r]);
      const removalsFirst = mid === r && rTo > r && aTo > a && !extendsTable;
      if (removalsFirst) removeBlocks(r, rTo, newAt(a), oldAt(r));
      if (aTo > aMid) {
        const newStart = atEnd && rTo === r ? takeBefore(newText, newAt(aMid)) : newAt(aMid);
        const old = removalsFirst ? oldAt(rTo) : oldAt(mid);
        out.push({ oldStart: old, oldEnd: old, newStart, newEnd: newAt(aTo), block: true });
      }
      if (rTo > mid && !removalsFirst) {
        const oldStart = atEnd && aTo === a ? takeBefore(oldText, oldAt(mid)) : oldAt(mid);
        removeBlocks(mid, rTo, newAt(aTo), oldStart);
      }
      r = rTo;
      a = aTo;
    };
    for (const [pr, pa] of pairs) {
      flush(pr, pa);
      out.push(...lineChanges(oldLines[pr], newLines[pa], deadline - Date.now()));
      r = pr + 1;
      a = pa + 1;
    }
    flush(i + removed, j + added);
    i += removed;
    j += added;
  }
  return out;
}

/**
 * Where a baseline offset sits in the new text: by arithmetic inside
 * unchanged text, at the start of the replacement inside a change. Locates
 * passages a revision deleted outright.
 */
export function mapFromBaseline(changes: TrackedChange[], offset: number): number {
  let delta = 0;
  for (const c of changes) {
    if (offset < c.oldStart) break;
    if (offset < c.oldEnd) return c.newStart;
    delta = c.newEnd - c.oldEnd;
  }
  return offset + delta;
}

/**
 * Where an offset in the new text sat in the baseline, or null when it's
 * inside text the revision added — the inverse of mapFromBaseline over
 * unchanged text.
 */
export function mapToBaseline(changes: TrackedChange[], offset: number): number | null {
  let delta = 0;
  for (const c of changes) {
    if (offset < c.newStart) break;
    if (offset < c.newEnd) return null;
    delta = c.oldEnd - c.newEnd;
  }
  return offset + delta;
}

/** What a revision did to an old span: kept (moved by edits around it),
 *  rewritten (into the text that replaced it), or deleted outright. */
export type SpanFate =
  | { kind: "kept" | "rewritten"; start: number; end: number }
  | { kind: "deleted" };

/**
 * The fate of the old span [start, end) under `changes`, with its new
 * location. A span no change touches keeps its words exactly; one whose
 * words a change removed maps to what replaced them — the change's own added
 * text, or for a removed block, the block added straight after it — and is
 * deleted when nothing did and none of its words survive.
 */
export function spanFate(
  changes: TrackedChange[],
  oldText: string,
  newText: string,
  start: number,
  end: number,
): SpanFate {
  const hit = changes.filter((c) => c.oldStart < c.oldEnd && c.oldStart < end && c.oldEnd > start);
  if (!hit.length) {
    return { kind: "kept", start: mapFromBaseline(changes, start), end: mapFromBaseline(changes, end - 1) + 1 };
  }
  const replacementOf = (c: TrackedChange): [number, number] | null => {
    if (c.newEnd > c.newStart) return [c.newStart, c.newEnd];
    const next = changes[changes.indexOf(c) + 1];
    const replaced =
      c.block &&
      next?.block &&
      next.oldStart === next.oldEnd &&
      next.newStart === c.newStart &&
      newText.slice(next.newStart, next.newEnd).trim() !== "";
    return replaced ? [next.newStart, next.newEnd] : null;
  };
  const reps = hit.map(replacementOf);
  // do any of its words lie outside every change that removed text?
  let survives = false;
  for (let k = start, h = 0; k < end && !survives; k++) {
    while (h < hit.length && hit[h].oldEnd <= k) h++;
    const inside = h < hit.length && hit[h].oldStart <= k;
    if (!inside && /\S/.test(oldText[k])) survives = true;
  }
  if (!survives && reps.every((r) => r === null)) return { kind: "deleted" };
  const first = hit[0];
  const last = hit[hit.length - 1];
  const newStart = start >= first.oldStart ? (reps[0]?.[0] ?? first.newStart) : mapFromBaseline(changes, start);
  let newEnd = end <= last.oldEnd ? (reps[reps.length - 1]?.[1] ?? last.newStart) : mapFromBaseline(changes, end - 1) + 1;
  while (newEnd > newStart && /\s/.test(newText[newEnd - 1])) newEnd--;
  return newEnd > newStart ? { kind: "rewritten", start: newStart, end: newEnd } : { kind: "deleted" };
}
