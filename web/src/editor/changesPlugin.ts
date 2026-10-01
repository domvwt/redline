/**
 * Tracked changes in the rendered document: the diff between the
 * last-reviewed baseline and the current text, drawn as decorations —
 * revised wording underlined or struck through in place, whole paragraphs
 * added or removed marked as blocks. Both sides are plain text (the anchor
 * domain the comments use), so the diff never shows markdown syntax churn.
 */
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import type { Node as PmNode } from "@milkdown/kit/prose/model";
import { trackChanges, type BlockLayout, type TrackedChange } from "@redline/shared";
import { commentsKey, type CommentsPluginState } from "./commentsPlugin.ts";
import { OffsetIndex } from "./offsets.ts";

/** The last-reviewed baseline as plain text, with its block layout. */
export interface Baseline extends BlockLayout {
  text: string;
}

/** Tracked-changes plugin state. */
export interface ChangesPluginState {
  /** null = nothing to compare */
  baseline: Baseline | null;
  show: boolean;
  /** every change against the current doc (plain-text offsets),
   *  whitespace-only ones included so offset mapping stays exact */
  regions: TrackedChange[];
  /** changes worth drawing — what the reviewer sees counted */
  count: number;
  decorations: DecorationSet;
  /** PM spans of what's drawn, to tell which comments' passages show a change */
  drawn: Array<{ from: number; to: number }>;
  /** focus mode: the removal (by baseline offset) whose struck block is lit */
  spot: number | null;
}

type Meta =
  | { type: "baseline"; baseline: Baseline | null }
  | { type: "show"; show: boolean }
  | { type: "spot"; oldStart: number | null };

/** Plugin key for reading the tracked-changes state and sending it meta. */
export const changesKey = new PluginKey<ChangesPluginState>("redline-changes");

/** a change worth drawing: whitespace-only reflows carry no meaning */
function isVisible(r: TrackedChange, oldText: string, newText: string): boolean {
  if (r.whitespace) {
    // indentation counts; a blank line added or dropped has nothing to show
    const strip = (t: string) => t.replace(/\n/g, "");
    return strip(oldText.slice(r.oldStart, r.oldEnd)) !== strip(newText.slice(r.newStart, r.newEnd));
  }
  return (
    oldText.slice(r.oldStart, r.oldEnd).trim() !== "" ||
    newText.slice(r.newStart, r.newEnd).trim() !== ""
  );
}

/** whether `pos` sits anywhere inside a table */
const inTable = (doc: PmNode, pos: number) => {
  const $pos = doc.resolve(pos);
  for (let d = $pos.depth; d > 0; d--) if ($pos.node(d).type.name.startsWith("table")) return true;
  return false;
};

/**
 * Where a removed block is drawn. A pure deletion sits just before the
 * textblock now at its offset, hoisted out of any list, quote or table that
 * textblock opens (it preceded the whole container); a replacement stays
 * with what replaced it. Between table cells there is no room for a block,
 * so the removal goes inline at the start of its own cell — found by block
 * position, since an emptied cell has no text for an offset to land on.
 */
function placeRemoval(
  doc: PmNode,
  index: OffsetIndex,
  offset: number,
  replaced: boolean,
): { pos: number; asBlock: boolean } {
  const k = index.blockStarts.findIndex((start) => start >= offset);
  if (k === -1) return { pos: doc.content.size, asBlock: true };
  const textblock = index.blockPositions[k];
  let pos = textblock;
  if (!replaced) {
    for (let $pos = doc.resolve(pos); $pos.depth > 0 && $pos.index() === 0; $pos = doc.resolve(pos)) {
      pos = $pos.before();
    }
  }
  return inTable(doc, pos) ? { pos: textblock + 1, asBlock: false } : { pos, asBlock: true };
}

/** kind of the block holding `offset` in a layout ("table:0" → "table") */
export function containerAt(layout: BlockLayout, offset: number): string | undefined {
  let kind: string | undefined;
  layout.blockStarts.forEach((start, k) => {
    if (start <= offset) kind = layout.blockKinds?.[k];
  });
  return kind?.split(":")[0];
}

/** a removal directly followed by its replacement — an addition of the same
 *  kind, with text, where it stood (an emptied cell replaces nothing; of
 *  several removals sharing one addition, only the last is replaced) */
const isReplaced = (r: TrackedChange, regions: TrackedChange[], newText: string) => {
  const o = regions[regions.indexOf(r) + 1];
  return (
    !!o &&
    o.block === r.block && // a word added to the next paragraph replaces no block
    o.oldStart === o.oldEnd &&
    o.newStart === r.newStart &&
    newText.slice(o.newStart, o.newEnd).trim() !== ""
  );
};

/**
 * Removed text as the reader knew it: table cells joined into rows, list
 * items bulleted, other blocks a line each.
 */
function formatRemoved(baseline: Baseline, r: TrackedChange): string {
  const lines: string[] = [];
  let row: string[] = [];
  const flushRow = () => row.length && (lines.push(row.join(" | ")), (row = []));
  const starts = baseline.blockStarts;
  let past = false;
  starts.forEach((start, k) => {
    if (past) return;
    const end = k + 1 < starts.length ? starts[k + 1] : baseline.text.length;
    const from = Math.max(start, r.oldStart);
    const to = Math.min(end, r.oldEnd);
    const text = baseline.text.slice(from, to).replace(/\n+$/, "");
    const [kind, column] = (baseline.blockKinds?.[k] ?? "").split(":");
    // an empty cell still holds its column — trailing ones too, which share
    // their start with whatever follows the removal
    const trailingEmpty =
      start >= r.oldEnd &&
      !baseline.text.slice(start, end).trim() &&
      row.length > 0 &&
      Number(column) === row.length;
    if (start >= r.oldEnd && !trailingEmpty) past = true;
    if (kind === "table" && start >= r.oldStart && (start < r.oldEnd || trailingEmpty)) {
      if (column === "0") flushRow();
      row.push(text.trim());
      return;
    }
    if (from >= to || !text.trim()) return;
    flushRow();
    // a paragraph's soft wraps were only ever spaces; code keeps its lines
    const flowed = kind === "code" ? text : text.replace(/\n/g, " ");
    lines.push(kind === "list" && from === start ? `• ${flowed}` : flowed);
  });
  flushRow();
  return lines.join("\n") || baseline.text.slice(r.oldStart, r.oldEnd).replace(/^\n+|\n+$/g, "");
}

/** every change from the baseline to `doc`, and how many are worth drawing —
 *  a removal and the block that replaced it count once */
function diff(doc: PmNode, baseline: Baseline | null) {
  if (!baseline) return { regions: [], count: 0 };
  const index = new OffsetIndex(doc);
  const regions = trackChanges(baseline.text, index.text, baseline, index);
  const count = regions.filter(
    (r) => isVisible(r, baseline.text, index.text) && !(r.newStart === r.newEnd && isReplaced(r, regions, index.text)),
  ).length;
  return { regions, count };
}

/** decorations for the visible changes, plus the PM spans they cover */
function draw(doc: PmNode, baseline: Baseline | null, regions: TrackedChange[], spot: number | null) {
  const drawn: ChangesPluginState["drawn"] = [];
  if (!baseline || !regions.length) return { decorations: DecorationSet.empty, drawn };
  const index = new OffsetIndex(doc);
  const decos: Decoration[] = [];
  for (const r of regions) {
    if (!isVisible(r, baseline.text, index.text)) continue;
    const removed = r.block
      ? formatRemoved(baseline, r)
      : baseline.text.slice(r.oldStart, r.oldEnd).replace(/^\n+|\n+$/g, "");
    const added = index.text.slice(r.newStart, r.newEnd);
    if (removed.trim() || (r.whitespace && baseline.text.slice(r.oldStart, r.oldEnd).replace(/\n/g, ""))) {
      // a rewrite lights with its replacement in Focus, whatever the container,
      // but stays put only within its own kind: a paragraph replaced by a list
      // preceded the list, not its first item
      const rewritten = isReplaced(r, regions, index.text);
      const replaced = rewritten && containerAt(baseline, r.oldStart) === containerAt(index, r.newStart);
      // word-level: past the end, toPm lands at the end of the last text —
      // still inside the last paragraph, where trailing removed words belong
      const { pos, asBlock } = r.block
        ? placeRemoval(doc, index, r.newStart, replaced)
        : { pos: index.toPm(r.newStart), asBlock: false };
      // inline, code keeps its line breaks (a deleted line stays a line), a
      // table's rows separate with a dot, a paragraph's soft wraps were spaces
      const inCode = !asBlock && !!doc.resolve(pos).parent.type.spec.code;
      const text = inCode
        ? baseline.text.slice(r.oldStart, r.oldEnd)
        : asBlock
          ? removed
          : removed.replace(/\n/g, r.block ? " · " : " ");
      const classes = [asBlock ? "rl-del-block" : "rl-del"];
      if (rewritten) classes.push("rl-del-replaced");
      if (r.oldStart === spot) classes.push("rl-spot-del");
      drawn.push({ from: pos, to: pos });
      decos.push(
        Decoration.widget(
          pos,
          () => {
            const el = document.createElement(asBlock ? "div" : "del");
            el.className = classes.join(" ");
            el.textContent = text;
            return el;
          },
          { side: -1, ignoreSelection: true, key: `del-${classes.join()}-${r.oldStart}-${removed}` },
        ),
      );
    }
    if (added.trim() || (r.whitespace && added.replace(/\n/g, ""))) {
      // underline the words, not the spaces around them — unless the spaces
      // are the change (indentation in code)
      const lead = r.whitespace ? 0 : added.length - added.trimStart().length;
      const trail = r.whitespace ? 0 : added.length - added.trimEnd().length;
      const from = index.toPm(r.newStart + lead);
      const to = index.toPm(r.newEnd - trail);
      if (from < to) {
        drawn.push({ from, to });
        decos.push(Decoration.inline(from, to, { class: "rl-ins" }));
        if (r.block && !inTable(doc, from)) {
          doc.nodesBetween(from, to, (node, pos) => {
            if (!node.isTextblock) return true;
            decos.push(Decoration.node(pos, pos + node.nodeSize, { class: "rl-ins-block" }));
            return false;
          });
        }
      }
    }
  }
  return { decorations: DecorationSet.create(doc, decos), drawn };
}

/** comments whose passage shows a drawn change, sorted for cheap comparison */
function commentsWithChanges(comments: CommentsPluginState | undefined, drawn: ChangesPluginState["drawn"]) {
  if (!comments || !drawn.length) return [];
  return comments.ranges
    .filter((r) => !r.collapsed && drawn.some((d) => d.from <= r.to && d.to >= r.from))
    .map((r) => r.id)
    .sort();
}

/**
 * Tracked-changes plugin. The diff reruns only when the document or the
 * baseline changes; show/hide just redraws. Reports the visible change count,
 * and which comments' passages show a change, whenever either moves.
 */
export function createChangesPlugin(bridge: {
  onCount(count: number): void;
  onCommentsWithChanges(ids: string[]): void;
}): Plugin<ChangesPluginState> {
  return new Plugin<ChangesPluginState>({
    key: changesKey,
    view: () => {
      let lastCount = -1;
      // null, not "": a fresh editor must report even an empty first list,
      // or the app keeps the previous document's
      let lastIds: string | null = null;
      return {
        update(view) {
          const changes = changesKey.getState(view.state);
          const count = changes?.count ?? 0;
          if (count !== lastCount) bridge.onCount((lastCount = count));
          const ids = commentsWithChanges(commentsKey.getState(view.state), changes?.drawn ?? []);
          if (ids.join() !== lastIds) {
            lastIds = ids.join();
            bridge.onCommentsWithChanges(ids);
          }
        },
      };
    },
    state: {
      init: () => ({
        baseline: null,
        show: true,
        regions: [],
        count: 0,
        decorations: DecorationSet.empty,
        drawn: [],
        spot: null,
      }),
      apply(tr, prev, _old, state) {
        const meta = tr.getMeta(changesKey) as Meta | undefined;
        if (!meta && !tr.docChanged) return prev;
        const next = { ...prev };
        if (meta?.type === "show") next.show = meta.show;
        if (meta?.type === "baseline") next.baseline = meta.baseline;
        if (meta?.type === "spot") next.spot = meta.oldStart;
        if (meta?.type === "baseline" || tr.docChanged) {
          Object.assign(next, diff(state.doc, next.baseline));
        }
        Object.assign(
          next,
          next.show
            ? draw(state.doc, next.baseline, next.regions, next.spot)
            : { decorations: DecorationSet.empty, drawn: [] },
        );
        return next;
      },
    },
    props: {
      decorations: (state) => changesKey.getState(state)?.decorations ?? DecorationSet.empty,
    },
  });
}
