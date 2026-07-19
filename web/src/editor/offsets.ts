import type { Node as PmNode } from "@milkdown/kit/prose/model";

interface Segment {
  pmFrom: number;
  pmTo: number;
  textFrom: number;
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
        this.segments.push({ pmFrom: pos, pmTo: pos + node.nodeSize, textFrom: text.length });
        text += node.text;
        return true;
      }
      if (node.isInline && node.isLeaf) {
        // hardbreak (and any break-like atom) renders as a line break; images
        // contribute their alt text — same rules as the server-side renderer
        if (node.type.name.includes("break")) {
          if (!text.endsWith("\n")) text += "\n";
        } else if (node.type.name === "image") {
          text += String((node.attrs as { alt?: string }).alt ?? "");
        }
      }
      return true;
    });
    this.text = text;
  }

  /** PM position -> plain-text offset. Bias resolves boundary/gap positions. */
  toText(pmPos: number, bias: "start" | "end" = "start"): number {
    for (const seg of this.segments) {
      if (pmPos < seg.pmFrom) {
        // in a gap (block boundary / inline atom): snap forward for "start",
        // backward for "end"
        if (bias === "start") return seg.textFrom;
        return Math.max(0, seg.textFrom - 1);
      }
      const within = bias === "end" ? pmPos <= seg.pmTo : pmPos < seg.pmTo;
      if (within && pmPos >= seg.pmFrom) {
        return seg.textFrom + (pmPos - seg.pmFrom);
      }
    }
    const last = this.segments[this.segments.length - 1];
    if (!last) return 0;
    return last.textFrom + (last.pmTo - last.pmFrom);
  }

  /** Plain-text offset -> PM position. */
  toPm(textOffset: number): number {
    for (const seg of this.segments) {
      const segLen = seg.pmTo - seg.pmFrom;
      const segTextEnd = seg.textFrom + segLen;
      if (textOffset < seg.textFrom) return seg.pmFrom; // fell on a separator
      if (textOffset <= segTextEnd) return seg.pmFrom + (textOffset - seg.textFrom);
    }
    const last = this.segments[this.segments.length - 1];
    return last ? last.pmTo : 0;
  }
}
