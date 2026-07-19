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
import { resolveAnchor, type Annotation } from "@redline/shared";
import { commentsKey, createCommentsPlugin, type CommentRange } from "./commentsPlugin.ts";
import { createImagePlugin } from "./imagePlugin.ts";
import { OffsetIndex } from "./offsets.ts";

export interface SelectionInfo {
  start: number; // plain-text offsets
  end: number;
  rect: { top: number; left: number };
}

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
}

interface Props {
  docPath: string;
  initialMarkdown: string;
  onReady(): void;
  onDirty(): void;
  onSelectText(info: SelectionInfo | null): void;
  onClickComment(id: string): void;
}

export const EditorPane = forwardRef<EditorHandle, Props>(function EditorPane(
  { docPath, initialMarkdown, onReady, onDirty, onSelectText, onClickComment },
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
  const callbacks = useRef({ onReady, onDirty, onSelectText, onClickComment });
  callbacks.current = { onReady, onDirty, onSelectText, onClickComment };

  useEffect(() => {
    let disposed = false;
    const plugin = $prose(() =>
      createCommentsPlugin({ onClickComment: (id) => callbacks.current.onClickComment(id) }),
    );
    const imagePlugin = $prose(() => createImagePlugin(docPath));

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
      .use(imagePlugin);

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
