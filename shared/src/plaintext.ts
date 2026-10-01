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
  return markdownToPlainBlocks(markdown).text;
}

/** textblocks: each starts a block in the editor's OffsetIndex too */
const TEXTBLOCK_TYPES = new Set(["paragraph", "heading", "code", "tableCell"]);

/** a block's kind is its nearest container's, else its own; table cells add
 *  their column, "table:1" (see OffsetIndex) */
const CONTAINER_KINDS: Record<string, string> = {
  tableCell: "table",
  listItem: "list",
  blockquote: "quote",
};

/**
 * markdownToPlainText plus where each textblock begins — what tells a new
 * paragraph from a soft-wrapped line, which both render as '\n' — and its
 * kind (paragraph, heading, code, table, list, quote).
 */
export function markdownToPlainBlocks(markdown: string): {
  text: string;
  blockStarts: number[];
  blockKinds: string[];
} {
  // Normalize CRLF / lone CR up front: the editor's OffsetIndex can never emit
  // \r, so leaving it in would drift every offset on CRLF-authored docs.
  const normalized = markdown.replace(/\r\n?/g, "\n");
  const tree = unified().use(remarkParse).use(remarkGfm).parse(normalized) as MdNode;
  let out = "";
  const blockStarts: number[] = [];
  const blockKinds: string[] = [];

  const newline = () => {
    if (out.length > 0 && !out.endsWith("\n")) out += "\n";
  };

  const visit = (node: MdNode, container?: string, index = 0) => {
    if (TEXTBLOCK_TYPES.has(node.type)) {
      blockStarts.push(out.length);
      blockKinds.push(
        node.type === "tableCell"
          ? `table:${index}`
          : node.type === "code"
            ? "code" // code stays code inside a list or quote: it diffs by line
            : (CONTAINER_KINDS[node.type] ?? container ?? node.type),
      );
    }
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
      for (const [k, child] of node.children.entries()) {
        visit(child, CONTAINER_KINDS[node.type] ?? container, k);
        if (BLOCK_TYPES.has(child.type)) newline();
      }
    }
  };

  visit(tree);
  return { text: out.replace(/\n+$/, ""), blockStarts, blockKinds };
}
