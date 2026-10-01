import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import { Editor, defaultValueCtx, editorViewCtx, rootCtx } from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
import { history } from "@milkdown/kit/plugin/history";
import { $prose, getMarkdown, replaceAll } from "@milkdown/kit/utils";
import type { Node as PmNode } from "@milkdown/kit/prose/model";
import type { EditorView } from "@milkdown/kit/prose/view";
import {
  ALIGN_EVIDENCE,
  blockSimilarity,
  mapFromBaseline,
  markdownToPlainBlocks,
  resolveAnchor,
  type Annotation,
  type TrackedChange,
} from "@redline/shared";
import { changesKey, containerAt, createChangesPlugin } from "./changesPlugin.ts";
import {
  commentsKey,
  createCommentsPlugin,
  type CommentRange,
  type Spotlight,
} from "./commentsPlugin.ts";
import { createImagePlugin } from "./imagePlugin.ts";
import { OffsetIndex } from "./offsets.ts";

/** A settled text selection: plain-text offsets plus where to anchor the popover. */
export interface SelectionInfo {
  start: number; // plain-text offsets
  end: number;
  rect: { top: number; left: number };
}

/** Imperative editor API exposed to the app via ref. */
export interface EditorHandle {
  /** Replace content wholesale (external change from Claude/git). */
  setContent(markdown: string): void;
  /** null while the editor is still initializing */
  getMarkdown(): string | null;
  /** Current plain-text anchors for every tracked comment range. */
  getAnchors(): Array<{ id: string; start: number; end: number }>;
  /** Plain text as the editor sees it. */
  getPlainText(): string;
  setRangesFromAnnotations(annotations: Annotation[], positionHintsValid: boolean): void;
  focusComment(id: string | null): void;
  scrollToComment(id: string): void;
  setEditable(editable: boolean): void;
  /** Pending-comment highlight (plain-text offsets), or null to clear. */
  setDraft(range: { start: number; end: number } | null): void;
  /** Scroll to a plain-text range and flash it (search results). */
  scrollToRange(start: number, end: number): void;
  /** Last-reviewed markdown to draw tracked changes against; null clears. */
  setBaseline(markdown: string | null): void;
  /** Draw or hide the tracked-change decorations (the count still updates). */
  setShowChanges(show: boolean): void;
  /**
   * Focus mode: light the comment's passage (CSS dims the rest) and centre
   * it. A passage the revision deleted is located through the baseline diff
   * instead. Returns whether anything was lit; null clears.
   */
  spotlight(annotation: Annotation | null, scroll?: boolean): boolean;
  /**
   * Where each comment's passage is now (plain-text offsets; unknown ones are
   * left out), and each one's live text — what its card's "now" reads.
   */
  positionsOf(annotations: Annotation[]): { positions: Map<string, number>; live: Map<string, string> };
}

interface Props {
  docPath: string;
  initialMarkdown: string;
  onReady(): void;
  onDirty(): void;
  onSelectText(info: SelectionInfo | null): void;
  onClickComment(id: string): void;
  /** number of tracked changes against the baseline, on every change */
  onChangeCount(count: number): void;
  /** ids of comments whose passage currently shows a drawn change */
  onCommentsWithChanges(ids: string[]): void;
}

/**
 * Where a comment's passage is in the current doc: the server's anchor
 * (re-anchoring already follows rewrites and orphans deletions, using the
 * revision's diff), with the passage's own struck text lit beside it; or,
 * for an orphaned passage, the change that removed it, found in the
 * baseline and carried across the diff.
 */
function locate(view: EditorView, annotation: Annotation, index: OffsetIndex): Spotlight | null {
  const tracked = commentsKey
    .getState(view.state)
    ?.ranges.find((r) => r.id === annotation.id && !r.collapsed && r.from < r.to);
  const was = locateInBaseline(view, annotation, index);
  if (!tracked || annotation.status === "orphaned") return was?.spot ?? null;
  // the live range without the separators a re-anchored quote ("\n…",
  // "…\n") can carry, which would reach into the neighbouring block
  const rawStart = index.toText(tracked.from);
  const raw = index.text.slice(rawStart, index.toText(tracked.to, "end"));
  const liveStart = rawStart + (raw.length - raw.trimStart().length);
  const liveEnd = Math.max(liveStart + 1, rawStart + raw.trimEnd().length);
  const live = { from: index.toPm(liveStart), to: index.toPm(liveEnd) };
  return was?.changed ? { ...live, deletion: was.spot.deletion, inline: was.spot.inline } : live;
}

/**
 * The comment's passage in the baseline — an exact match of either quote
 * preferred (a stale priorQuote may fuzzily hit something else) — and the
 * change, if any, that removed words from it.
 */
function locateInBaseline(view: EditorView, annotation: Annotation, index: OffsetIndex) {
  const changes = changesKey.getState(view.state);
  if (!annotation.target || !changes?.baseline) return null;
  const baseline = changes.baseline;
  // priorQuote may predate the baseline (an earlier pass); the selector's own
  // quote may be what the baseline still holds
  const [quote, position] = annotation.target.selector;
  const hits = [annotation.priorQuote, quote]
    .filter((q) => q != null)
    .map((q) => {
      const found = resolveAnchor(baseline.text, {
        ...annotation,
        target: { ...annotation.target!, selector: [q, position] },
      });
      return found && { found, exact: baseline.text.slice(found.start, found.end) === q.exact };
    })
    .filter((h) => h !== null);
  const hit = hits.find((h) => h.exact) ?? hits[0];
  if (!hit) return null;
  const { found } = hit;
  const at = index.toPm(mapFromBaseline(changes.regions, found.start));
  // the first drawn change that removed words from the passage
  const region = changes.regions.find(
    (r) =>
      baseline.text.slice(r.oldStart, r.oldEnd).trim() !== "" &&
      r.oldStart < found.end &&
      r.oldEnd > found.start,
  );
  if (!region) {
    return { spot: { from: at, to: at } as Spotlight, changed: false };
  }
  const point = index.toPm(region.newStart);
  const isPureRemoval = (x: TrackedChange) => x.block && x.newStart === x.newEnd;
  const pureRemoval = isPureRemoval(region);
  // what replaced it: the change's own added text plus the additions that
  // directly follow it — a rewrite split across new blocks, as far as they
  // share words with the old text (an unrelated insertion after it isn't
  // part of it). Additions before it belong to the block before
  const oldWords = baseline.text.slice(region.oldStart, region.oldEnd);
  // one of a container's items that a block of another kind replaced whole
  // (a list rewritten as a paragraph): the block after the run of removed
  // items is its replacement too. Separate deletions don't run together
  let at0 = changes.regions.indexOf(region);
  const container = containerAt(baseline, region.oldStart);
  if (pureRemoval && (container === "list" || container === "quote" || container === "table")) {
    let k = at0;
    while (
      k + 1 < changes.regions.length &&
      isPureRemoval(changes.regions[k + 1]) &&
      changes.regions[k + 1].oldStart === changes.regions[k].oldEnd &&
      changes.regions[k + 1].newStart === region.newStart &&
      containerAt(baseline, changes.regions[k + 1].oldStart) === container
    ) {
      k++;
    }
    const after = changes.regions[k + 1];
    const replacedByOther =
      after && after.oldStart === after.oldEnd && containerAt(index, after.newStart) !== container;
    if (replacedByOther) at0 = k;
  }
  let hi = at0;
  const follows = (x: TrackedChange, y: TrackedChange) =>
    y.oldStart === y.oldEnd && x.newEnd === y.newStart && x.oldEnd === y.oldStart;
  while (hi + 1 < changes.regions.length && follows(changes.regions[hi], changes.regions[hi + 1])) {
    const next = changes.regions[hi + 1];
    // the removals' own replacement: a whole added block, not a word added
    // to the next paragraph
    const first = hi === at0 && isPureRemoval(changes.regions[at0]) && next.block;
    if (!first && blockSimilarity(oldWords, index.text.slice(next.newStart, next.newEnd)) < ALIGN_EVIDENCE) break;
    hi++;
  }
  const runStart = region.newStart;
  const runEnd = changes.regions[hi].newEnd;
  const added = index.text.slice(runStart, runEnd).trim() !== "" ? { start: runStart, end: runEnd } : null;
  // the spot covers the struck text and what replaced it (its trailing
  // separator would reach into the next block)
  const repEnd = added ? added.start + index.text.slice(added.start, added.end).trimEnd().length : 0;
  return {
    spot: added
      ? { from: index.toPm(added.start), to: index.toPm(repEnd), deletion: region.oldStart, inline: !region.block }
      : { from: point, to: point, deletion: region.oldStart, inline: !region.block },
    changed: hit.exact,
  };
}

/** The Milkdown editor for one document, with comment and tracked-change plugins. */
export const EditorPane = forwardRef<EditorHandle, Props>(function EditorPane(
  {
    docPath,
    initialMarkdown,
    onReady,
    onDirty,
    onSelectText,
    onClickComment,
    onChangeCount,
    onCommentsWithChanges,
  },
  ref,
) {
  const rootRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Programmatic content replacement (external reload) must not echo back as
  // a user edit. Milkdown's listener debounces `updated` by ~200ms, so we
  // can't clear a flag on the next tick; instead we snapshot the doc that
  // setContent installed and suppress only when `updated` reports exactly
  // that doc — a keystroke in the window changes the doc and is never lost.
  const suppressDoc = useRef<PmNode | null>(null);

  // Callbacks live in refs so the plugin (created once) sees fresh ones.
  const current = {
    onReady,
    onDirty,
    onSelectText,
    onClickComment,
    onChangeCount,
    onCommentsWithChanges,
  };
  const callbacks = useRef(current);
  callbacks.current = current;

  useEffect(() => {
    let disposed = false;
    const plugin = $prose(() =>
      createCommentsPlugin({ onClickComment: (id) => callbacks.current.onClickComment(id) }),
    );
    const imagePlugin = $prose(() => createImagePlugin(docPath));
    const changesPlugin = $prose(() =>
      createChangesPlugin({
        onCount: (n) => callbacks.current.onChangeCount(n),
        onCommentsWithChanges: (ids) => callbacks.current.onCommentsWithChanges(ids),
      }),
    );

    const editor = Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, rootRef.current!);
        ctx.set(defaultValueCtx, initialMarkdown);
        ctx.get(listenerCtx).updated((_ctx, doc) => {
          const suppressed = suppressDoc.current?.eq(doc) ?? false;
          suppressDoc.current = null;
          if (!suppressed) callbacks.current.onDirty();
        });
      })
      .use(commonmark)
      .use(gfm)
      .use(history)
      .use(listener)
      .use(plugin)
      .use(imagePlugin)
      .use(changesPlugin);

    void editor.create().then((instance) => {
      if (disposed) {
        void instance.destroy();
        return;
      }
      editorRef.current = instance;
      instance.action((ctx) => {
        viewRef.current = ctx.get(editorViewCtx);
      });
      callbacks.current.onReady();
    });

    // Report the selection only once it has SETTLED (mouseup / end of a
    // shift-navigation), so the comment affordance doesn't chase the cursor.
    const NAV_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]);
    const report = () => {
      const view = viewRef.current;
      if (!view) return;
      const { from, to, empty } = view.state.selection;
      if (empty || to - from < 1) {
        callbacks.current.onSelectText(null);
        return;
      }
      const index = new OffsetIndex(view.state.doc);
      const coords = view.coordsAtPos(to);
      callbacks.current.onSelectText({
        start: index.toText(from, "start"),
        end: index.toText(to, "end"),
        rect: { top: coords.bottom, left: coords.left },
      });
    };
    // Track drags that START in the editor and report on mouseup anywhere —
    // releasing the button outside the pane is common on long selections.
    let dragFromEditor = false;
    const onMouseDown = () => {
      dragFromEditor = true;
    };
    const onDocMouseUp = () => {
      if (!dragFromEditor) return;
      dragFromEditor = false;
      setTimeout(report, 0); // let PM apply the selection first
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const view = viewRef.current;
      if (!view) return;
      if (e.shiftKey && NAV_KEYS.has(e.key)) setTimeout(report, 0);
      // typing collapsed the selection -> retire any stale affordance
      else if (view.state.selection.empty) callbacks.current.onSelectText(null);
    };
    const rootEl = rootRef.current!;
    rootEl.addEventListener("mousedown", onMouseDown);
    document.addEventListener("mouseup", onDocMouseUp);
    rootEl.addEventListener("keyup", onKeyUp);

    return () => {
      disposed = true;
      rootEl.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("mouseup", onDocMouseUp);
      rootEl.removeEventListener("keyup", onKeyUp);
      viewRef.current = null;
      void editorRef.current?.destroy();
      editorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // one editor per mount; parent remounts with key={path}

  useImperativeHandle(ref, () => ({
    setContent(markdown: string) {
      const editor = editorRef.current;
      if (!editor) return;
      editor.action(replaceAll(markdown));
      // snapshot AFTER the replace so the suppressed doc is exactly what the
      // listener will report if no user edit follows
      suppressDoc.current = viewRef.current?.state.doc ?? null;
    },
    getMarkdown() {
      const editor = editorRef.current;
      if (!editor) return null; // not ready — callers must NOT save "" over the doc
      return editor.action(getMarkdown());
    },
    getAnchors() {
      const view = viewRef.current;
      if (!view) return [];
      const state = commentsKey.getState(view.state);
      if (!state) return [];
      const index = new OffsetIndex(view.state.doc);
      return state.ranges
        .filter((r) => !r.collapsed)
        .map((r) => ({
          id: r.id,
          start: index.toText(r.from, "start"),
          end: index.toText(r.to, "end"),
        }));
    },
    getPlainText() {
      const view = viewRef.current;
      return view ? new OffsetIndex(view.state.doc).text : "";
    },
    setRangesFromAnnotations(annotations, positionHintsValid) {
      const view = viewRef.current;
      if (!view) return;
      const index = new OffsetIndex(view.state.doc);
      const ranges: CommentRange[] = [];
      for (const a of annotations) {
        if (a.status === "resolved" || !a.target) continue;
        if (a.status === "orphaned") {
          ranges.push({ id: a.id, from: 0, to: 0, status: a.status, collapsed: true });
          continue;
        }
        const result = resolveAnchor(index.text, a, { positionHintValid: positionHintsValid });
        if (result) {
          ranges.push({
            id: a.id,
            from: index.toPm(result.start),
            to: index.toPm(result.end),
            status: a.status,
            collapsed: false,
          });
        } else {
          ranges.push({ id: a.id, from: 0, to: 0, status: a.status, collapsed: true });
        }
      }
      view.dispatch(view.state.tr.setMeta(commentsKey, { type: "set", ranges }));
    },
    focusComment(id) {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch(view.state.tr.setMeta(commentsKey, { type: "focus", id }));
    },
    scrollToComment(id) {
      const view = viewRef.current;
      if (!view) return;
      const state = commentsKey.getState(view.state);
      const range = state?.ranges.find((r) => r.id === id);
      if (!range || range.collapsed) return;
      const dom = view.domAtPos(range.from);
      const el = dom.node instanceof HTMLElement ? dom.node : dom.node.parentElement;
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
    },
    setEditable(editable) {
      viewRef.current?.setProps({ editable: () => editable });
    },
    scrollToRange(start, end) {
      const view = viewRef.current;
      if (!view) return;
      const index = new OffsetIndex(view.state.doc);
      const from = index.toPm(start);
      const to = index.toPm(end);
      const dom = view.domAtPos(from);
      const el = dom.node instanceof HTMLElement ? dom.node : dom.node.parentElement;
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
      // brief flash so the eye lands on the match — but only clear OUR flash;
      // a real comment draft started in the meantime must survive
      view.dispatch(view.state.tr.setMeta(commentsKey, { type: "draft", range: { from, to } }));
      setTimeout(() => {
        const current = viewRef.current;
        if (!current) return;
        const draft = commentsKey.getState(current.state)?.draft;
        if (draft && draft.from === from && draft.to === to) {
          current.dispatch(current.state.tr.setMeta(commentsKey, { type: "draft", range: null }));
        }
      }, 1600);
    },
    setBaseline(markdown) {
      const view = viewRef.current;
      if (!view) return;
      const baseline = markdown === null ? null : markdownToPlainBlocks(markdown);
      view.dispatch(view.state.tr.setMeta(changesKey, { type: "baseline", baseline }));
    },
    setShowChanges(show) {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch(view.state.tr.setMeta(changesKey, { type: "show", show }));
    },
    spotlight(annotation, scroll = true) {
      const view = viewRef.current;
      if (!view) return false;
      const located = annotation ? locate(view, annotation, new OffsetIndex(view.state.doc)) : null;
      let spot = located;
      // struck text shows only while changes are drawn: hidden, what replaced
      // it (or the paragraph a change sits in) stays lit; a removed block
      // with nothing in its place lights nothing — its neighbour is unrelated
      if (spot?.deletion !== undefined && !changesKey.getState(view.state)?.show) {
        spot = spot.from < spot.to || spot.inline ? { from: spot.from, to: spot.to } : null;
      }
      view.dispatch(
        view.state.tr
          .setMeta(commentsKey, { type: "spotlight", range: spot })
          .setMeta(changesKey, { type: "spot", oldStart: spot?.deletion ?? null }),
      );
      if (located && scroll) {
        const dom = view.domAtPos(located.from);
        const el = dom.node instanceof HTMLElement ? dom.node : dom.node.parentElement;
        el?.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      return spot !== null;
    },
    positionsOf(annotations) {
      const view = viewRef.current;
      const out = new Map<string, number>();
      const live = new Map<string, string>();
      if (!view) return { positions: out, live };
      const ranges = commentsKey.getState(view.state)?.ranges ?? [];
      for (const r of ranges) {
        if (!r.collapsed && r.from < r.to) live.set(r.id, view.state.doc.textBetween(r.from, r.to, "\n").trim());
      }
      const index = new OffsetIndex(view.state.doc);
      for (const a of annotations) {
        const spot = locate(view, a, index);
        if (spot) {
          out.set(a.id, index.toText(spot.from));
          continue;
        }
        // gone and past the baseline: the text that led into it, if it
        // survives, still says where it was
        const lead = a.target?.selector[0].prefix.trim().slice(-24);
        if (!lead) continue;
        // of several, the one nearest where it used to be
        const was = a.target!.selector[1].start;
        let best = -1;
        for (let at = index.text.indexOf(lead); at !== -1; at = index.text.indexOf(lead, at + 1)) {
          if (best === -1 || Math.abs(at - was) < Math.abs(best - was)) best = at;
        }
        if (best !== -1) out.set(a.id, best + lead.length);
      }
      return { positions: out, live };
    },
    setDraft(range) {
      const view = viewRef.current;
      if (!view) return;
      const meta = range
        ? {
            type: "draft" as const,
            range: {
              from: new OffsetIndex(view.state.doc).toPm(range.start),
              to: new OffsetIndex(view.state.doc).toPm(range.end),
            },
          }
        : { type: "draft" as const, range: null };
      view.dispatch(view.state.tr.setMeta(commentsKey, meta));
    },
  }));

  return <div ref={rootRef} className="rl-editor" />;
});
