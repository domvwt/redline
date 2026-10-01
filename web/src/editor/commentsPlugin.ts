import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import type { AnnotationStatus } from "@redline/shared";

/** A comment's highlighted range in the editor (PM positions). */
export interface CommentRange {
  id: string;
  from: number;
  to: number;
  status: AnnotationStatus;
  /** range collapsed by local edits — treated as unanchored until next save */
  collapsed: boolean;
}

/** Comments plugin state. */
export interface CommentsPluginState {
  ranges: CommentRange[];
  focusedId: string | null;
  /** pending highlight while the author is typing a new comment */
  draft: { from: number; to: number } | null;
  /** focus mode: the passage under review; its top-level blocks stay lit */
  spotlight: Spotlight | null;
}

/**
 * A Focus-mode spotlight. `deletion`: the passage was a block the revision
 * removed (its baseline offset) — the changes plugin lights that struck
 * block itself, so no neighbour here is lit.
 */
export interface Spotlight {
  from: number;
  to: number;
  deletion?: number;
  /** the change sits inside a paragraph, not a removed block of its own */
  inline?: boolean;
}

/** Plugin key for reading the comments state and sending it meta. */
export const commentsKey = new PluginKey<CommentsPluginState>("redline-comments");

/** Callbacks from the comments plugin to the React app. */
export interface UiBridge {
  onClickComment(id: string): void;
}

type Meta =
  | { type: "set"; ranges: CommentRange[] }
  | { type: "focus"; id: string | null }
  | { type: "draft"; range: { from: number; to: number } | null }
  | { type: "spotlight"; range: Spotlight | null };

/** Comment highlights, the draft highlight, and the focus-mode spotlight. */
export function createCommentsPlugin(bridge: UiBridge): Plugin<CommentsPluginState> {
  return new Plugin<CommentsPluginState>({
    key: commentsKey,
    state: {
      init: () => ({ ranges: [], focusedId: null, draft: null, spotlight: null }),
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
            // a spotlit passage the change swept away goes dark rather than
            // stretching over the whole replacement; the app re-lights it
            spotlight: (() => {
              const spot = next.spotlight;
              if (!spot) return null;
              const from = tr.mapping.mapResult(spot.from, -1);
              const to = tr.mapping.mapResult(spot.to, 1);
              return from.deleted || to.deleted ? null : { ...spot, from: from.pos, to: to.pos };
            })(),
          };
        }
        const meta = tr.getMeta(commentsKey) as Meta | undefined;
        if (meta?.type === "set") next = { ...next, ranges: meta.ranges };
        if (meta?.type === "focus") next = { ...next, focusedId: meta.id };
        if (meta?.type === "draft") next = { ...next, draft: meta.range };
        if (meta?.type === "spotlight") next = { ...next, spotlight: meta.range };
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
        const spot = pluginState.spotlight;
        // a deletion spot lights its struck text through the changes plugin,
        // plus whatever replaced it
        if (spot && (spot.deletion === undefined || spot.from < spot.to)) {
          state.doc.forEach((node, offset) => {
            const end = offset + node.nodeSize;
            // inclusive at the edges: a zero-width spot (a deletion point)
            // still finds the block it sits in
            if (end >= spot.from && offset <= spot.to) {
              decos.push(Decoration.node(offset, end, { class: "rl-spot" }));
            }
          });
          // the passage's own textblocks, so a lit list or table can dim the
          // items around it
          state.doc.nodesBetween(spot.from, Math.max(spot.to, spot.from + 1), (node, pos) => {
            if (!node.isTextblock) return true;
            decos.push(Decoration.node(pos, pos + node.nodeSize, { class: "rl-spot-in" }));
            return false;
          });
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
