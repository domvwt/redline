import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";

interface MdNode {
  type: string;
  value?: string;
  alt?: string;
  children?: MdNode[];
}

const BLOCK_TYPES = new Set([
  "paragraph",
  "heading",
  "listItem",
  "blockquote",
  "code",
  "tableRow",
  "tableCell",
  "thematicBreak",
]);

/**
 * Canonical plain-text rendering of a markdown document.
 *
 * Rules (mirrored by the editor's OffsetIndex — keep the two in sync):
 * - inline text / inlineCode / code blocks contribute their literal value
 * - hard breaks and block boundaries contribute a single '\n' (never doubled,
 *   never leading — blocks that render nothing must not emit separators)
 * - table cells separate with '\n' (each cell is a textblock in the editor)
 * - images contribute their alt text
 */
export function markdownToPlainText(markdown: string): string {
  // Normalize CRLF / lone CR up front: the editor's OffsetIndex can never emit
  // \r, so leaving it in would drift every offset on CRLF-authored docs.
  const normalized = markdown.replace(/\r\n?/g, "\n");
  const tree = unified().use(remarkParse).use(remarkGfm).parse(normalized) as MdNode;
  let out = "";

  const newline = () => {
    if (out.length > 0 && !out.endsWith("\n")) out += "\n";
  };

  const visit = (node: MdNode) => {
    if (node.type === "text" || node.type === "inlineCode" || node.type === "code") {
      out += node.value ?? "";
      if (node.type === "code") newline();
      return;
    }
    if (node.type === "break") {
      newline();
      return;
    }
    if (node.type === "image") {
      out += node.alt ?? "";
      return;
    }
    if (node.children) {
      for (const child of node.children) {
        visit(child);
        if (BLOCK_TYPES.has(child.type)) newline();
      }
    }
  };

  visit(tree);
  return out.replace(/\n+$/, "");
}
