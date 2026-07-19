import search from "approx-string-match";

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

export interface ReplyEdit {
  path: string;
  search: string;
  replace: string;
}

export interface ReplyResolution {
  id: string;
  action: "resolved" | "declined";
  note: string;
}

export interface ParsedReply {
  edits: ReplyEdit[];
  resolutions: ReplyResolution[];
  /** human-readable problems: truncated block, malformed JSON, unknown action… */
  warnings: string[];
}

/** start/end span the replacement text in the resulting markdown */
export type EditOutcome =
  | { status: "applied"; start: number; end: number }
  | { status: "fuzzy"; start: number; end: number; errors: number }
  | { status: "ambiguous"; occurrences: number }
  | { status: "failed"; reason: string };

export interface ApplyResult {
  markdown: string;
  outcomes: EditOutcome[]; // 1:1 with input edits
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
    c.quote === null
      ? `(${wholeLabel})`
      : `…${c.prefix ?? ""}«${c.quote}»${c.suffix ?? ""}…`;
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
    "## Reply format (strict — a tool parses your reply)",
    "",
    "Return each edit as a fenced code block whose info string is",
    "`redline:edit <path>`, containing exactly one SEARCH/REPLACE pair:",
    "",
    "````",
    "```redline:edit docs/example.md",
    "<<<<<<< SEARCH",
    "teh quick brown fox",
    "=======",
    "the quick brown fox",
    ">>>>>>> REPLACE",
    "```",
    "````",
    "",
    "- SEARCH text must be copied verbatim from the document — including exact",
    "  whitespace. Keep it as short as possible while still unique in the",
    "  document.",
    "- Use one block per edit, as many blocks as you need. Never return the",
    "  whole revised document.",
    "- After all edit blocks, end your reply with exactly ONE resolutions",
    "  block: a fenced block with info string `redline:resolutions` whose body",
    "  is a JSON array with one entry per comment:",
    "",
    "````",
    "```redline:resolutions",
    "[",
    '  { "id": "c1", "action": "resolved", "note": "Fixed the typo." },',
    '  { "id": "c2", "action": "declined", "note": "The figure is correct as written." }',
    "]",
    "```",
    "````",
    "",
    '- "action" is "resolved" or "declined". "note" is written to the author:',
    "  explain what changed, or why you declined.",
    "- Every comment gets a resolution entry, even when no text changed —",
    "  declined with a reason, or resolved noting which other edit covered it.",
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
      "may require no text change — each still needs its own resolution entry.",
      "",
    );
    for (const c of projectNotes) out.push(...renderComment(c, "project-wide note"));
  }

  return out.join("\n");
}

// Marker lines tolerate leading/trailing whitespace and 3-or-more marker chars
// — chat UIs and sloppy assistants mangle both.
const SEARCH_RE = /^\s*<{3,}\s*SEARCH\s*$/;
const DIVIDER_RE = /^\s*={3,}\s*$/;
const REPLACE_RE = /^\s*>{3,}\s*REPLACE\s*$/;
const EDIT_FENCE_RE = /^\s*(?:`{3,}|~{3,})\s*redline:edit\s+(.+?)\s*$/;
const FENCE_OPEN_RE = /^\s*(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_RE = /^\s*(`{3,}|~{3,})\s*$/;

const RESOLVED_ACTIONS = new Set(["resolved", "done", "fixed", "accepted"]);
const DECLINED_ACTIONS = new Set(["declined", "rejected", "wontfix"]);

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

function normalizeResolutions(items: unknown, warnings: string[]): ReplyResolution[] {
  if (!Array.isArray(items)) {
    warnings.push("resolutions block is not a JSON array; ignored");
    return [];
  }
  const out: ReplyResolution[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) {
      warnings.push("resolution entry is not an object; skipped");
      continue;
    }
    const { id, action, note } = item as Record<string, unknown>;
    if (typeof id !== "string" || typeof action !== "string") {
      warnings.push("resolution entry missing string id or action; skipped");
      continue;
    }
    const norm = action.trim().toLowerCase();
    if (RESOLVED_ACTIONS.has(norm)) {
      out.push({ id, action: "resolved", note: typeof note === "string" ? note : "" });
    } else if (DECLINED_ACTIONS.has(norm)) {
      out.push({ id, action: "declined", note: typeof note === "string" ? note : "" });
    } else {
      warnings.push(`unknown resolution action "${action}" for comment ${id}; entry skipped`);
    }
  }
  return out;
}

export function parseReply(text: string, opts: { defaultPath?: string } = {}): ParsedReply {
  const warnings: string[] = [];
  const edits: ReplyEdit[] = [];
  const lines = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  // lines belonging to edit blocks — excluded from resolution scanning so
  // JSON-looking content inside an edit's SEARCH/REPLACE is never misread
  const consumed = new Set<number>();

  let i = 0;
  while (i < lines.length) {
    if (!SEARCH_RE.test(lines[i])) {
      i++;
      continue;
    }
    const blockStart = i;
    // path from a `redline:edit <path>` fence line preceding SEARCH (blank
    // lines skipped); the fence itself is optional
    let path: string | undefined;
    let fenceLine = -1;
    for (let j = i - 1; j >= 0; j--) {
      if (lines[j].trim() === "") continue;
      const m = EDIT_FENCE_RE.exec(lines[j]);
      if (m) {
        path = m[1];
        fenceLine = j;
      }
      break;
    }
    path ??= opts.defaultPath;

    i++;
    const searchLines: string[] = [];
    while (i < lines.length && !DIVIDER_RE.test(lines[i]) && !SEARCH_RE.test(lines[i])) {
      searchLines.push(lines[i]);
      i++;
    }
    if (i >= lines.length) {
      warnings.push("reply appears truncated: edit block never reached its ======= divider");
      break;
    }
    if (SEARCH_RE.test(lines[i])) {
      warnings.push("malformed edit block: new SEARCH marker before ======= divider; block dropped");
      continue; // re-scan from the new marker
    }

    i++;
    const replaceLines: string[] = [];
    while (i < lines.length && !REPLACE_RE.test(lines[i]) && !SEARCH_RE.test(lines[i])) {
      replaceLines.push(lines[i]);
      i++;
    }
    if (i >= lines.length) {
      warnings.push("reply appears truncated: edit block never reached its REPLACE marker");
      break;
    }
    if (SEARCH_RE.test(lines[i])) {
      warnings.push("malformed edit block: new SEARCH marker before REPLACE marker; block dropped");
      continue;
    }

    i++; // past the REPLACE marker
    if (fenceLine !== -1) consumed.add(fenceLine);
    for (let j = blockStart; j < i; j++) consumed.add(j);
    if (i < lines.length && FENCE_CLOSE_RE.test(lines[i])) consumed.add(i);

    if (path === undefined) {
      warnings.push("edit block has no redline:edit path and no default path; block skipped");
      continue;
    }
    edits.push({ path, search: searchLines.join("\n"), replace: replaceLines.join("\n") });
  }

  // Fenced-block enumeration for resolutions. Nested fences inside a body are
  // not tracked — the first bare fence line closes the block — which is safe
  // here because a resolutions body is JSON, and edit-block lines (the only
  // fence-bearing content) are excluded via `consumed`.
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
    let closed = false;
    let k = j + 1;
    for (; k < lines.length; k++) {
      const close = FENCE_CLOSE_RE.exec(lines[k]);
      if (close && close[1][0] === marks[0] && close[1].length >= marks.length) {
        closed = true;
        break;
      }
      body.push(lines[k]);
    }
    blocks.push({ info: rawInfo.trim(), body: body.join("\n"), closed });
    j = k; // resume after the closing fence (or at EOF)
  }

  const parseArray = (body: string): unknown | undefined => {
    const span = extractArraySpan(body.replace(/^\uFEFF/, ""));
    if (span === null) return undefined;
    try {
      return JSON.parse(span);
    } catch {
      return undefined;
    }
  };

  let resolutions: ReplyResolution[] = [];
  const tagged = blocks.filter((b) => b.info.includes("redline:resolutions"));
  if (tagged.length > 0) {
    if (tagged.length > 1) {
      warnings.push("multiple redline:resolutions blocks; only the first was used");
    }
    const body = tagged[0].body.replace(/^\uFEFF/, "");
    const span = extractArraySpan(body);
    if (span === null) {
      warnings.push("resolutions block contains no JSON array");
    } else {
      try {
        resolutions = normalizeResolutions(JSON.parse(span), warnings);
      } catch (err) {
        warnings.push(`resolutions block contains malformed JSON: ${(err as Error).message}`);
      }
    }
  } else {
    // fallback: any fenced JSON block shaped like a resolutions array
    let found = false;
    for (const b of blocks) {
      const parsed = parseArray(b.body);
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
        resolutions = normalizeResolutions(parsed, warnings);
        found = true;
        break;
      }
    }
    if (!found) warnings.push("no resolutions block found in reply");
  }

  return { edits, resolutions, warnings };
}

// Below this length, whitespace-lenient and approximate matching false-match
// too easily; only an exact hit is trusted.
const MIN_FUZZY_SEARCH_LEN = 12;

function findAllExact(haystack: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    out.push(idx);
    idx = haystack.indexOf(needle, idx + 1);
  }
  return out;
}

/**
 * Match with whitespace runs collapsed on both sides, mapping the hit back to
 * original coordinates — catches the #1 chat-assistant failure: re-wrapped
 * lines.
 */
function lenientMatches(
  haystack: string,
  needle: string,
): Array<{ start: number; end: number }> {
  const chars: string[] = [];
  const origStart: number[] = [];
  const origEnd: number[] = [];
  let i = 0;
  while (i < haystack.length) {
    if (/\s/.test(haystack[i])) {
      let j = i;
      while (j < haystack.length && /\s/.test(haystack[j])) j++;
      chars.push(" ");
      origStart.push(i);
      origEnd.push(j);
      i = j;
    } else {
      chars.push(haystack[i]);
      origStart.push(i);
      origEnd.push(i + 1);
      i++;
    }
  }
  const collapsedHay = chars.join("");
  const collapsedNeedle = needle.replace(/\s+/g, " ").trim();
  if (!collapsedNeedle) return [];
  return findAllExact(collapsedHay, collapsedNeedle).map((s) => ({
    start: origStart[s],
    end: origEnd[s + collapsedNeedle.length - 1],
  }));
}

function splice(text: string, start: number, end: number, replacement: string): string {
  return text.slice(0, start) + replacement + text.slice(end);
}

function applyOne(text: string, edit: ReplyEdit): { text: string; outcome: EditOutcome } {
  const needle = edit.search;
  const hits = findAllExact(text, needle);
  if (hits.length === 1) {
    const start = hits[0];
    return {
      text: splice(text, start, start + needle.length, edit.replace),
      outcome: { status: "applied", start, end: start + edit.replace.length },
    };
  }
  if (hits.length > 1) {
    // every occurrence yields the same result string only when the edit is a
    // no-op — treat as applied at the first occurrence
    if (needle === edit.replace) {
      return {
        text,
        outcome: { status: "applied", start: hits[0], end: hits[0] + edit.replace.length },
      };
    }
    return { text, outcome: { status: "ambiguous", occurrences: hits.length } };
  }

  if (needle.length < MIN_FUZZY_SEARCH_LEN) {
    return { text, outcome: { status: "failed", reason: "search text too short to match safely" } };
  }

  const lenient = lenientMatches(text, needle);
  if (lenient.length === 1) {
    const { start, end } = lenient[0];
    return {
      text: splice(text, start, end, edit.replace),
      outcome: { status: "fuzzy", start, end: start + edit.replace.length, errors: 0 },
    };
  }
  if (lenient.length > 1) {
    return { text, outcome: { status: "ambiguous", occurrences: lenient.length } };
  }

  const maxErrors = Math.ceil(needle.length * 0.2);
  // approx-string-match can return degenerate matches for garbled needles;
  // require the match to retain most of the search text (as in anchor-core)
  const matches = search(text, needle, maxErrors).filter(
    (m) => m.end - m.start >= needle.length * 0.5,
  );
  if (matches.length > 0) {
    const minErrors = Math.min(...matches.map((m) => m.errors));
    // the library reports several overlapping spans per site — collapse them,
    // so only genuinely distinct sites count toward ambiguity
    const sites: Array<{ start: number; end: number }> = [];
    for (const m of matches
      .filter((m) => m.errors === minErrors)
      .sort((a, b) => a.start - b.start)) {
      const last = sites[sites.length - 1];
      if (last && m.start < last.end) continue;
      sites.push({ start: m.start, end: m.end });
    }
    if (sites.length > 1) {
      return { text, outcome: { status: "ambiguous", occurrences: sites.length } };
    }
    const { start, end } = sites[0];
    return {
      text: splice(text, start, end, edit.replace),
      outcome: { status: "fuzzy", start, end: start + edit.replace.length, errors: minErrors },
    };
  }

  return { text, outcome: { status: "failed", reason: "search text not found" } };
}

/** Apply edits sequentially: each edit sees the result of the previous one. */
export function applyEdits(markdown: string, edits: ReplyEdit[]): ApplyResult {
  let text = markdown;
  const outcomes: EditOutcome[] = [];
  for (const edit of edits) {
    const result = applyOne(text, edit);
    text = result.text;
    outcomes.push(result.outcome);
  }
  return { markdown: text, outcomes };
}
