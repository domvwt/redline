import type { Node as PmNode } from "@milkdown/kit/prose/model";

interface Segment {
  pmFrom: number;
  pmTo: number;
  textFrom: number;
  textTo: number;
}

/**
 * Bidirectional index between ProseMirror positions and offsets in the
 * document's plain-text rendering. Textblocks are separated by '\n'; inline
 * break nodes (hard/soft breaks from wrapped markdown source) also emit '\n',
 * matching shared/plaintext.ts — without this, words on either side of a
 * wrapped line jam together and every later offset drifts.
 */
export class OffsetIndex {
  readonly text: string;
  private segments: Segment[] = [];

  constructor(doc: PmNode) {
    let text = "";
    doc.descendants((node, pos) => {
      if (node.isTextblock && pos > 0 && text.length > 0 && !text.endsWith("\n")) {
        text += "\n";
      }
      if (node.isText && node.text) {
        this.segments.push({
          pmFrom: pos,
          pmTo: pos + node.nodeSize,
          textFrom: text.length,
          textTo: text.length + node.text.length,
        });
        text += node.text;
        return true;
      }
      if (node.isInline && node.isLeaf) {
        // hardbreak (and any break-like atom) renders as a line break; images
        // contribute their alt text — same rules as the server-side renderer
        if (node.type.name.includes("break")) {
          if (!text.endsWith("\n")) text += "\n";
        } else if (node.type.name === "image") {
          const alt = String((node.attrs as { alt?: string }).alt ?? "");
          if (alt) {
            // atom node: one PM position spans the whole alt text; toText/toPm
            // clamp interior offsets to the node boundary
            this.segments.push({
              pmFrom: pos,
              pmTo: pos + node.nodeSize,
              textFrom: text.length,
              textTo: text.length + alt.length,
            });
          }
          text += alt;
        }
      }
      return true;
    });
    this.text = text;
  }

  /** PM position -> plain-text offset. Bias resolves boundary/gap positions. */
  toText(pmPos: number, bias: "start" | "end" = "start"): number {
    let prevTextTo = 0;
    for (const seg of this.segments) {
      if (pmPos < seg.pmFrom) {
        // in a gap (block boundary / break atom): snap forward for "start",
        // backward for "end" — but never past the previous segment's text
        // (separator de-duplication can leave a gap with no text of its own)
        if (bias === "start") return seg.textFrom;
        return Math.max(prevTextTo, seg.textFrom - 1);
      }
      const within = bias === "end" ? pmPos <= seg.pmTo : pmPos < seg.pmTo;
      if (within && pmPos >= seg.pmFrom) {
        // atom segments (image alt) are wider in text than in PM: the node
        // end maps to the alt end, interior positions clamp to the alt span
        if (pmPos >= seg.pmTo) return seg.textTo;
        return Math.min(seg.textFrom + (pmPos - seg.pmFrom), seg.textTo);
      }
      prevTextTo = seg.textTo;
    }
    const last = this.segments[this.segments.length - 1];
    if (!last) return 0;
    return last.textTo;
  }

  /** Plain-text offset -> PM position. */
  toPm(textOffset: number): number {
    for (const seg of this.segments) {
      if (textOffset < seg.textFrom) return seg.pmFrom; // fell on a separator
      if (textOffset <= seg.textTo) {
        // atom segments (image alt) have no interior PM positions: clamp so
        // any offset inside the alt lands on the node's edge
        return Math.min(seg.pmFrom + (textOffset - seg.textFrom), seg.pmTo);
      }
    }
    const last = this.segments[this.segments.length - 1];
    return last ? last.pmTo : 0;
  }
}
