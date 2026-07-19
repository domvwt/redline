export interface HandoffComment {
  id: string;
  /** null for document-level or project-level notes */
  quote: string | null;
  prefix: string | null;
  suffix: string | null;
  comment: string;
  /** prior back-and-forth, oldest first */
  thread: Array<{ by: "author" | "claude" | "agent"; text: string }>;
}

export interface HandoffDoc {
  path: string;
  markdown: string;
  comments: HandoffComment[];
}

export interface ReplyResolution {
  id: string;
  action: "resolved" | "declined";
  note: string;
}

export interface ParsedReply {
  /** complete revised documents, one per changed doc */
  documents: Array<{ path: string; markdown: string }>;
  responses: ReplyResolution[];
  /** human-readable problems: truncated block, malformed JSON, unknown action… */
  warnings: string[];
}

/**
 * Backtick fence guard for embedding arbitrary text: one more backtick than
 * the longest run in the content, never fewer than 4 — so documents that
 * themselves contain code fences survive embedding.
 */
export function fence(text: string): string {
  let longest = 0;
  for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  return "`".repeat(Math.max(4, longest + 1));
}

function renderComment(c: HandoffComment, wholeLabel: string): string[] {
  const where =
    c.quote === null ? `(${wholeLabel})` : `…${c.prefix ?? ""}«${c.quote}»${c.suffix ?? ""}…`;
  const lines = [`- Comment \`${c.id}\` — ${where}`, `  - comment: ${c.comment}`];
  for (const t of c.thread) {
    // "claude" is the historic wire value for agent entries (see types.ts)
    lines.push(`  - ${t.by === "author" ? "author" : "agent"}: ${t.text}`);
  }
  return lines;
}

export function buildHandoffPrompt(
  docs: HandoffDoc[],
  opts: { projectNotes?: HandoffComment[] } = {},
): string {
  const out: string[] = [
    "# Redline handoff: review comments to address",
    "",
    "You are acting as a careful editor. The documents below carry margin",
    "comments from their author. Address each comment with the smallest edit",
    "that resolves it.",
    "",
    "Ground rules:",
    "",
    "- Read every comment before editing anything, and look for themes that",
    "  span comments — related comments may deserve one coherent fix.",
    "- Preserve the author's voice and formatting. Do NOT rewrite passages",
    "  nobody commented on.",
    "- If a comment is misguided or would make the text worse, decline it with",
    "  a reason instead of editing.",
    "",
    "## Reply format (a tool parses your reply)",
    "",
    "Reply in two parts.",
    "",
    "**Part 1 — respond to every comment**, one line per comment, in a list.",
    "Each line starts with the comment id in brackets, then your verdict and a",
    "note written to the author:",
    "",
    "- `- [<id>] resolved: <what you changed>`",
    "- `- [<id>] declined: <why not>`",
    "",
    "These lines are read by the author in the chat AND parsed by the tool —",
    "keep each response on a single line. Every comment gets a response line,",
    "even when no text changed (declined with a reason, or resolved noting",
    "which other change covered it).",
    "",
    "**Part 2 — output the complete revised version of every document you",
    "changed**, each in its own fenced block whose info string is",
    "`redline:document <path>`. The ENTIRE document from first line to last —",
    "not a diff, not an excerpt, and no commentary inside the block. Omit",
    "documents you did not change. Use a fence of AT LEAST four backticks so",
    "documents containing three-backtick code fences survive.",
    "",
    "For example:",
    "",
    "`````",
    "- [c1] resolved: Fixed the typo in the install command.",
    "- [c2] declined: The figure is correct as written.",
    "",
    "````redline:document docs/example.md",
    "# Example",
    "",
    "The complete revised document, from first line to last.",
    "````",
    "`````",
    "",
    "## Documents",
  ];

  for (const doc of docs) {
    const g = fence(doc.markdown);
    out.push("", `### ${doc.path}`, "", g, doc.markdown, g);
    if (doc.comments.length > 0) {
      out.push("", `Comments on ${doc.path}:`, "");
      for (const c of doc.comments) out.push(...renderComment(c, "note on the whole document"));
    }
  }

  const projectNotes = opts.projectNotes ?? [];
  if (projectNotes.length > 0) {
    out.push(
      "",
      "## Project-wide notes",
      "",
      "These apply to the project as a whole rather than to one passage. They",
      "may require no text change — each still needs its own response line.",
      "",
    );
    for (const c of projectNotes) out.push(...renderComment(c, "project-wide note"));
  }

  return out.join("\n");
}

const DOC_FENCE_RE = /^\s*(`{3,}|~{3,})\s*redline:document\s+(.+?)\s*$/;
const FENCE_OPEN_RE = /^\s*(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_RE = /^\s*(`{3,}|~{3,})\s*$/;
// fence-imbalance guard counts fence lines at line starts (markdown allows up
// to three spaces of indent)
const FENCE_AT_LINE_START_RE = /^ {0,3}(?:`{3,}|~{3,})/;

const RESOLVED_ACTIONS = new Set(["resolved", "done", "fixed", "accepted"]);
const DECLINED_ACTIONS = new Set(["declined", "rejected", "wontfix"]);

function normalizeAction(action: string): "resolved" | "declined" | null {
  const norm = action.trim().toLowerCase();
  if (RESOLVED_ACTIONS.has(norm)) return "resolved";
  if (DECLINED_ACTIONS.has(norm)) return "declined";
  return null;
}

interface ResponseLine {
  id: string;
  action: string;
  note: string;
  /** a bracketed id is a strong signal the line was meant as a response */
  bracketed: boolean;
}

// `[id] <action>: note` — the separator before the action and the note itself
// are both optional when the id is bracketed.
const BRACKETED_RESPONSE_RE =
  /^\[\s*([^[\]\s]+)\s*\]\s*[—–:-]?\s*([A-Za-z][A-Za-z-]*)(?:\s*[—–:-]\s*(.*))?$/;
// `id — <action>: note` — a plain id requires explicit separators on both
// sides of the action so prose like "I resolved: it" cannot masquerade as a
// response line.
const PLAIN_RESPONSE_RE = /^([\w./-]+)(?:\s*[—–:]\s*|\s+-\s+)([A-Za-z][A-Za-z-]*)\s*[—–:-]\s*(.*)$/;

function parseResponseLine(line: string): ResponseLine | null {
  let s = line.trim();
  const bullet = /^(?:[-*+]|\d+[.)])\s+/.exec(s);
  if (bullet) s = s.slice(bullet[0].length);
  s = s.replace(/\*\*|__/g, ""); // bold markers around the id or action
  const bracketed = BRACKETED_RESPONSE_RE.exec(s);
  if (bracketed) {
    return {
      id: bracketed[1],
      action: bracketed[2],
      note: (bracketed[3] ?? "").trim(),
      bracketed: true,
    };
  }
  const plain = PLAIN_RESPONSE_RE.exec(s);
  if (plain) {
    return { id: plain[1], action: plain[2], note: plain[3].trim(), bracketed: false };
  }
  return null;
}

/**
 * Extract the first balanced `[` … `]` span, respecting JSON string literals —
 * assistants pad the array with prose inside the fence.
 */
function extractArraySpan(text: string): string | null {
  const start = text.indexOf("[");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function normalizeJsonResponses(items: unknown, warnings: string[]): ReplyResolution[] {
  if (!Array.isArray(items)) {
    warnings.push("responses block is not a JSON array; ignored");
    return [];
  }
  const out: ReplyResolution[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) {
      warnings.push("response entry is not an object; skipped");
      continue;
    }
    const { id, action, note } = item as Record<string, unknown>;
    if (typeof id !== "string" || typeof action !== "string") {
      warnings.push("response entry missing string id or action; skipped");
      continue;
    }
    const norm = normalizeAction(action);
    if (norm === null) {
      warnings.push(`unknown response action "${action}" for comment ${id}; entry skipped`);
      continue;
    }
    out.push({ id, action: norm, note: typeof note === "string" ? note : "" });
  }
  return out;
}

// Untagged fenced blocks shorter than this cannot be mistaken for a revised
// document in the defaultPath fallback.
const MIN_UNTAGGED_DOC_LEN = 200;

export function parseReply(text: string, opts: { defaultPath?: string } = {}): ParsedReply {
  const warnings: string[] = [];
  const documents: Array<{ path: string; markdown: string }> = [];
  const lines = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  // lines belonging to tagged document blocks — a document's content must
  // never be misread as response lines or as another fenced block
  const consumed = new Set<number>();
  let sawTaggedDoc = false;

  for (let i = 0; i < lines.length; i++) {
    const m = DOC_FENCE_RE.exec(lines[i]);
    if (!m) continue;
    sawTaggedDoc = true;
    const [, marks, path] = m;
    const body: string[] = [];
    let closed = false;
    let k = i + 1;
    for (; k < lines.length; k++) {
      const close = FENCE_CLOSE_RE.exec(lines[k]);
      if (close && close[1][0] === marks[0] && close[1].length >= marks.length) {
        closed = true;
        break;
      }
      body.push(lines[k]);
    }
    if (!closed) {
      // never let a half document through
      warnings.push(`reply appears truncated — ${path} was not applied`);
      for (let j = i; j < k; j++) consumed.add(j);
      break;
    }
    for (let j = i; j <= k; j++) consumed.add(j);
    // fence-collision guard: an odd number of fence lines inside the document
    // suggests the enclosing fence was too short and the content is suspect
    const fenceLineCount = body.filter((l) => FENCE_AT_LINE_START_RE.test(l)).length;
    if (fenceLineCount % 2 === 1) {
      warnings.push(`document ${path} has an unbalanced number of code fence lines`);
    }
    documents.push({ path, markdown: body.join("\n") });
    i = k;
  }

  const responses: ReplyResolution[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (consumed.has(i)) continue;
    const parsed = parseResponseLine(lines[i]);
    if (!parsed) continue;
    const action = normalizeAction(parsed.action);
    if (action !== null) {
      responses.push({ id: parsed.id, action, note: parsed.note });
      consumed.add(i);
    } else if (parsed.bracketed) {
      warnings.push(
        `unknown response action "${parsed.action}" for comment ${parsed.id}; line skipped`,
      );
    }
    // a plain-id line with an unknown action is ordinary prose — ignore it
  }

  // Remaining fenced blocks: the JSON responses fallback and the untagged
  // document fallback both draw from these. Nested fences are not tracked —
  // the first bare fence line of sufficient length closes a block.
  interface FencedBlock {
    info: string;
    body: string;
    closed: boolean;
  }
  const blocks: FencedBlock[] = [];
  for (let j = 0; j < lines.length; j++) {
    if (consumed.has(j)) continue;
    const open = FENCE_OPEN_RE.exec(lines[j]);
    if (!open) continue;
    const [, marks, rawInfo] = open;
    const body: string[] = [];
    let k = j + 1;
    let closed = false;
    for (; k < lines.length; k++) {
      const close = FENCE_CLOSE_RE.exec(lines[k]);
      if (close && close[1][0] === marks[0] && close[1].length >= marks.length) {
        closed = true;
        break;
      }
      body.push(lines[k]);
    }
    blocks.push({ info: rawInfo.trim(), body: body.join("\n"), closed });
    j = k;
  }

  // JSON fallback: some assistants still produce a resolutions-style array
  // instead of response lines.
  let jsonBlock: FencedBlock | null = null;
  if (responses.length === 0) {
    const tagged = blocks.find((b) => b.info.includes("redline:resolutions"));
    if (tagged) {
      jsonBlock = tagged;
      const span = extractArraySpan(tagged.body.replace(/^\uFEFF/, ""));
      if (span === null) {
        warnings.push("responses block contains no JSON array");
      } else {
        try {
          responses.push(...normalizeJsonResponses(JSON.parse(span), warnings));
        } catch (err) {
          warnings.push(`responses block contains malformed JSON: ${(err as Error).message}`);
        }
      }
    } else {
      for (const b of blocks) {
        const span = extractArraySpan(b.body.replace(/^\uFEFF/, ""));
        if (span === null) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(span);
        } catch {
          continue;
        }
        if (
          Array.isArray(parsed) &&
          parsed.length > 0 &&
          parsed.every(
            (item) =>
              typeof item === "object" &&
              item !== null &&
              typeof (item as Record<string, unknown>).id === "string" &&
              typeof (item as Record<string, unknown>).action === "string",
          )
        ) {
          jsonBlock = b;
          responses.push(...normalizeJsonResponses(parsed, warnings));
          break;
        }
      }
    }
  }

  // Untagged fallback: a lone fenced block of document-like size may be the
  // revised doc with its info string dropped — but only when no tagged block
  // was seen at all (a truncated tagged block must not be resurrected).
  if (!sawTaggedDoc && opts.defaultPath !== undefined) {
    const candidates = blocks.filter(
      (b) =>
        b !== jsonBlock &&
        b.closed &&
        !b.info.includes("redline:resolutions") &&
        b.body.length >= MIN_UNTAGGED_DOC_LEN,
    );
    if (candidates.length === 1) {
      warnings.push(
        `reply contained no redline:document block; assuming the untagged fenced block is ${opts.defaultPath}`,
      );
      documents.push({ path: opts.defaultPath, markdown: candidates[0].body });
    } else if (candidates.length > 1) {
      warnings.push(
        "reply contained no redline:document block and multiple untagged fenced blocks; no document applied",
      );
    }
  }

  if (responses.length === 0) warnings.push("no comment responses found in reply");

  return { documents, responses, warnings };
}
