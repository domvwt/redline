import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import type { AnnotationStatus } from "@redline/shared";

export interface CommentRange {
  id: string;
  from: number;
  to: number;
  status: AnnotationStatus;
  /** range collapsed by local edits — treated as unanchored until next save */
  collapsed: boolean;
}

export interface CommentsPluginState {
  ranges: CommentRange[];
  focusedId: string | null;
  /** pending highlight while the author is typing a new comment */
  draft: { from: number; to: number } | null;
}

export const commentsKey = new PluginKey<CommentsPluginState>("redline-comments");

export interface UiBridge {
  onClickComment(id: string): void;
}

type Meta =
  | { type: "set"; ranges: CommentRange[] }
  | { type: "focus"; id: string | null }
  | { type: "draft"; range: { from: number; to: number } | null };

export function createCommentsPlugin(bridge: UiBridge): Plugin<CommentsPluginState> {
  return new Plugin<CommentsPluginState>({
    key: commentsKey,
    state: {
      init: () => ({ ranges: [], focusedId: null, draft: null }),
      apply(tr, prev) {
        let next = prev;
        if (tr.docChanged) {
          next = {
            ...next,
            ranges: next.ranges.map((r) => {
              const from = tr.mapping.map(r.from, 1);
              const to = tr.mapping.map(r.to, -1);
              return from >= to ? { ...r, from, to, collapsed: true } : { ...r, from, to };
            }),
            draft: next.draft
              ? { from: tr.mapping.map(next.draft.from, 1), to: tr.mapping.map(next.draft.to, -1) }
              : null,
          };
        }
        const meta = tr.getMeta(commentsKey) as Meta | undefined;
        if (meta?.type === "set") next = { ...next, ranges: meta.ranges };
        if (meta?.type === "focus") next = { ...next, focusedId: meta.id };
        if (meta?.type === "draft") next = { ...next, draft: meta.range };
        return next;
      },
    },
    props: {
      decorations(state) {
        const pluginState = commentsKey.getState(state);
        if (!pluginState) return DecorationSet.empty;
        const decos: Decoration[] = [];
        for (const r of pluginState.ranges) {
          if (r.collapsed || r.status === "resolved") continue;
          const from = Math.max(0, Math.min(r.from, state.doc.content.size));
          const to = Math.max(from, Math.min(r.to, state.doc.content.size));
          if (from >= to) continue;
          const classes = ["rl-hl", `rl-hl-${r.status}`];
          if (r.id === pluginState.focusedId) classes.push("rl-hl-focused");
          decos.push(
            Decoration.inline(from, to, { class: classes.join(" "), "data-comment-id": r.id }),
          );
        }
        if (pluginState.draft && pluginState.draft.from < pluginState.draft.to) {
          decos.push(
            Decoration.inline(pluginState.draft.from, pluginState.draft.to, {
              class: "rl-hl rl-hl-draft",
            }),
          );
        }
        return DecorationSet.create(state.doc, decos);
      },
      handleClickOn(_view, _pos, _node, _nodePos, event) {
        const target = (event.target as HTMLElement).closest("[data-comment-id]");
        if (target) {
          bridge.onClickComment(target.getAttribute("data-comment-id")!);
          return false; // don't swallow the click; cursor still moves
        }
        return false;
      },
    },
  });
}
