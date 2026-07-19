import { describe, expect, it } from "vitest";
import {
  applyEdits,
  buildHandoffPrompt,
  fence,
  parseReply,
  type HandoffComment,
  type HandoffDoc,
} from "./handoff.ts";

function comment(id: string, overrides: Partial<HandoffComment> = {}): HandoffComment {
  return {
    id,
    quote: "quick brown fox",
    prefix: "The ",
    suffix: " jumps",
    comment: "tighten this",
    thread: [],
    ...overrides,
  };
}

describe("fence", () => {
  it("returns at least four backticks", () => {
    expect(fence("plain text")).toBe("````");
  });

  it("always exceeds the longest backtick run in the content", () => {
    expect(fence("has a ```js fence")).toBe("````");
    expect(fence("has ```` four")).toBe("`````");
  });
});

describe("buildHandoffPrompt", () => {
  const doc: HandoffDoc = {
    path: "docs/a.md",
    markdown: "# Title\n\nThe quick brown fox jumps.\n\n```js\ncode();\n```",
    comments: [
      comment("c1", { thread: [{ by: "author", text: "still unclear" }] }),
      comment("c2", { quote: null, prefix: null, suffix: null, comment: "overall tone" }),
    ],
  };

  it("embeds documents behind a fence guard that survives inner code fences", () => {
    const prompt = buildHandoffPrompt([doc]);
    // the doc contains a ``` run, so its guard must be 4 backticks
    expect(prompt).toContain("````\n" + doc.markdown + "\n````");
  });

  it("spells out the reply format with a worked example", () => {
    const prompt = buildHandoffPrompt([doc]);
    expect(prompt).toContain("redline:edit docs/example.md");
    expect(prompt).toContain("<<<<<<< SEARCH");
    expect(prompt).toContain(">>>>>>> REPLACE");
    expect(prompt).toContain("redline:resolutions");
    expect(prompt).toContain('"action": "declined"');
  });

  it("lists comments with marked quotes, threads, and whole-document notes", () => {
    const prompt = buildHandoffPrompt([doc]);
    expect(prompt).toContain("…The «quick brown fox» jumps…");
    expect(prompt).toContain("author: still unclear");
    expect(prompt).toContain("(note on the whole document)");
    expect(prompt).toContain("Comment `c1`");
    expect(prompt).toContain("Comment `c2`");
  });

  it("lists project notes in their own section", () => {
    const note = comment("p1", { quote: null, prefix: null, suffix: null, comment: "rename repo" });
    const prompt = buildHandoffPrompt([doc], { projectNotes: [note] });
    expect(prompt).toContain("## Project-wide notes");
    expect(prompt).toContain("(project-wide note)");
    expect(prompt).toContain("Comment `p1`");
  });
});

const RESOLUTIONS_BLOCK = [
  "```redline:resolutions",
  "[",
  '  { "id": "c1", "action": "resolved", "note": "Reworded." },',
  '  { "id": "c2", "action": "declined", "note": "Correct as written." }',
  "]",
  "```",
];

describe("parseReply", () => {
  it("parses a well-formed reply with two edits and resolutions", () => {
    const reply = [
      "Here are my edits.",
      "",
      "```redline:edit docs/a.md",
      "<<<<<<< SEARCH",
      "the quick brown fox",
      "=======",
      "the swift brown fox",
      ">>>>>>> REPLACE",
      "```",
      "",
      "```redline:edit docs/b.md",
      "<<<<<<< SEARCH",
      "lazy dog",
      "=======",
      "sleepy dog",
      ">>>>>>> REPLACE",
      "```",
      "",
      ...RESOLUTIONS_BLOCK,
    ].join("\n");
    const parsed = parseReply(reply);
    expect(parsed.edits).toEqual([
      { path: "docs/a.md", search: "the quick brown fox", replace: "the swift brown fox" },
      { path: "docs/b.md", search: "lazy dog", replace: "sleepy dog" },
    ]);
    expect(parsed.resolutions).toEqual([
      { id: "c1", action: "resolved", note: "Reworded." },
      { id: "c2", action: "declined", note: "Correct as written." },
    ]);
    expect(parsed.warnings).toEqual([]);
  });

  it("parses a reply the chat UI wrapped in one outer fence", () => {
    const reply = [
      "```",
      "```redline:edit docs/a.md",
      "<<<<<<< SEARCH",
      "old text",
      "=======",
      "new text",
      ">>>>>>> REPLACE",
      "```",
      ...RESOLUTIONS_BLOCK,
      "```",
    ].join("\n");
    const parsed = parseReply(reply);
    expect(parsed.edits).toEqual([{ path: "docs/a.md", search: "old text", replace: "new text" }]);
    expect(parsed.resolutions).toHaveLength(2);
  });

  it("keeps code fences inside SEARCH/REPLACE content verbatim", () => {
    const reply = [
      "````redline:edit docs/code.md",
      "<<<<<<< SEARCH",
      "```js",
      "old();",
      "```",
      "=======",
      "```js",
      "renewed();",
      "```",
      ">>>>>>> REPLACE",
      "````",
      ...RESOLUTIONS_BLOCK,
    ].join("\n");
    const parsed = parseReply(reply);
    expect(parsed.edits).toEqual([
      { path: "docs/code.md", search: "```js\nold();\n```", replace: "```js\nrenewed();\n```" },
    ]);
  });

  it("falls back to defaultPath when the redline:edit info string is missing", () => {
    const reply = [
      "<<<<<<< SEARCH",
      "old text",
      "=======",
      "new text",
      ">>>>>>> REPLACE",
      ...RESOLUTIONS_BLOCK,
    ].join("\n");
    const parsed = parseReply(reply, { defaultPath: "docs/only.md" });
    expect(parsed.edits).toEqual([{ path: "docs/only.md", search: "old text", replace: "new text" }]);
    expect(parsed.warnings).toEqual([]);
  });

  it("skips a pathless block with a warning when there is no defaultPath", () => {
    const reply = ["<<<<<<< SEARCH", "old", "=======", "new", ">>>>>>> REPLACE"].join("\n");
    const parsed = parseReply(reply);
    expect(parsed.edits).toEqual([]);
    expect(parsed.warnings.some((w) => w.includes("no redline:edit path"))).toBe(true);
  });

  it("drops a truncated final block with a warning, keeping earlier edits", () => {
    const reply = [
      "```redline:edit docs/a.md",
      "<<<<<<< SEARCH",
      "complete old",
      "=======",
      "complete new",
      ">>>>>>> REPLACE",
      "```",
      "```redline:edit docs/a.md",
      "<<<<<<< SEARCH",
      "the reply was cut off he",
    ].join("\n");
    const parsed = parseReply(reply);
    expect(parsed.edits).toEqual([
      { path: "docs/a.md", search: "complete old", replace: "complete new" },
    ]);
    expect(parsed.warnings.some((w) => w.includes("truncated"))).toBe(true);
  });

  it("extracts the resolutions array despite surrounding prose inside the fence", () => {
    const reply = [
      "```redline:resolutions",
      "Here are the resolutions you asked for:",
      '[ { "id": "c1", "action": "resolved", "note": "Done [see edit 1]." } ]',
      "Hope that helps!",
      "```",
    ].join("\n");
    const parsed = parseReply(reply);
    expect(parsed.resolutions).toEqual([
      { id: "c1", action: "resolved", note: "Done [see edit 1]." },
    ]);
  });

  it("finds resolutions in a plain json fence when the tagged block is missing", () => {
    const reply = [
      "```json",
      '[ { "id": "c1", "action": "resolved", "note": "ok" } ]',
      "```",
    ].join("\n");
    const parsed = parseReply(reply);
    expect(parsed.resolutions).toEqual([{ id: "c1", action: "resolved", note: "ok" }]);
  });

  it("normalizes loose action synonyms and skips unknown actions with a warning", () => {
    const reply = [
      "```redline:resolutions",
      "[",
      '  { "id": "c1", "action": "done", "note": "n1" },',
      '  { "id": "c2", "action": "wontfix", "note": "n2" },',
      '  { "id": "c3", "action": "maybe", "note": "n3" },',
      '  { "id": "c4", "action": "resolved" }',
      "]",
      "```",
    ].join("\n");
    const parsed = parseReply(reply);
    expect(parsed.resolutions).toEqual([
      { id: "c1", action: "resolved", note: "n1" },
      { id: "c2", action: "declined", note: "n2" },
      { id: "c4", action: "resolved", note: "" },
    ]);
    expect(parsed.warnings.some((w) => w.includes('unknown resolution action "maybe"'))).toBe(true);
  });

  it("warns about malformed resolutions JSON instead of throwing", () => {
    const reply = ["```redline:resolutions", '[ { "id": "c1", ', "```"].join("\n");
    const parsed = parseReply(reply);
    expect(parsed.resolutions).toEqual([]);
    expect(parsed.warnings.length).toBeGreaterThan(0);
  });

  it("warns when the reply has no resolutions block at all", () => {
    const parsed = parseReply("Sure, I can help with that!");
    expect(parsed.warnings.some((w) => w.includes("no resolutions block"))).toBe(true);
  });
});

describe("applyEdits", () => {
  const DOC = [
    "The quick brown fox jumps over the lazy dog.",
    "A second paragraph mentions the lazy dog again in passing.",
    "The final paragraph is about something else entirely.",
  ].join("\n");

  const edit = (search: string, replace: string) => ({ path: "a.md", search, replace });

  it("applies a unique exact match", () => {
    const r = applyEdits(DOC, [edit("quick brown fox", "swift brown fox")]);
    expect(r.markdown).toContain("The swift brown fox jumps");
    expect(r.outcomes[0]).toMatchObject({ status: "applied", start: DOC.indexOf("quick") });
  });

  it("reports ambiguous when the search text occurs twice", () => {
    const r = applyEdits(DOC, [edit("the lazy dog", "the sleepy dog")]);
    expect(r.markdown).toBe(DOC);
    expect(r.outcomes[0]).toEqual({ status: "ambiguous", occurrences: 2 });
  });

  it("treats a multi-occurrence no-op (search === replace) as applied", () => {
    const r = applyEdits(DOC, [edit("the lazy dog", "the lazy dog")]);
    expect(r.markdown).toBe(DOC);
    expect(r.outcomes[0]).toMatchObject({ status: "applied" });
  });

  it("matches a needle the assistant re-wrapped across lines", () => {
    const r = applyEdits(DOC, [
      edit("second paragraph mentions\nthe lazy dog again", "second paragraph revisits the dog"),
    ]);
    expect(r.markdown).toContain("A second paragraph revisits the dog in passing.");
    expect(r.outcomes[0]).toMatchObject({ status: "fuzzy", errors: 0 });
  });

  it("falls back to approximate matching for a typo'd needle", () => {
    const r = applyEdits(DOC, [
      edit("about smoething else entirley.", "about nothing in particular."),
    ]);
    expect(r.markdown).toContain("The final paragraph is about nothing in particular.");
    const outcome = r.outcomes[0];
    expect(outcome.status).toBe("fuzzy");
    if (outcome.status === "fuzzy") expect(outcome.errors).toBeGreaterThan(0);
  });

  it("fails a too-short unmatched search instead of fuzzy-matching it", () => {
    const r = applyEdits(DOC, [edit("zzq", "yyy")]);
    expect(r.markdown).toBe(DOC);
    expect(r.outcomes[0]).toEqual({
      status: "failed",
      reason: "search text too short to match safely",
    });
  });

  it("still applies a short search when it matches exactly once", () => {
    const r = applyEdits(DOC, [edit("jumps", "leaps")]);
    expect(r.markdown).toContain("brown fox leaps over");
    expect(r.outcomes[0]).toMatchObject({ status: "applied" });
  });

  it("applies edits sequentially so later edits see earlier results", () => {
    const r = applyEdits(DOC, [
      edit("quick brown fox", "nimble red panda"),
      edit("nimble red panda jumps", "nimble red panda vaults"),
    ]);
    expect(r.markdown).toContain("The nimble red panda vaults over");
    expect(r.outcomes).toHaveLength(2);
    expect(r.outcomes.every((o) => o.status === "applied")).toBe(true);
  });

  it("supports deletion via an empty replace", () => {
    const r = applyEdits(DOC, [edit(" again in passing", "")]);
    expect(r.markdown).toContain("mentions the lazy dog.");
    expect(r.outcomes[0]).toMatchObject({ status: "applied" });
  });

  it("fails cleanly when the search text is nowhere near the document", () => {
    const r = applyEdits(DOC, [edit("completely unrelated wording, nowhere present", "x")]);
    expect(r.markdown).toBe(DOC);
    expect(r.outcomes[0]).toEqual({ status: "failed", reason: "search text not found" });
  });
});

describe("round trip", () => {
  it("a reply written against the generated prompt parses and applies", () => {
    const doc: HandoffDoc = {
      path: "docs/guide.md",
      markdown: "# Guide\n\nAlways use `npm insatll` to fetch dependencies.\n",
      comments: [
        comment("c1", {
          quote: "npm insatll",
          prefix: "use `",
          suffix: "` to fetch",
          comment: "typo",
        }),
      ],
    };
    const prompt = buildHandoffPrompt([doc]);
    expect(prompt).toContain(doc.markdown);

    const reply = [
      "```redline:edit docs/guide.md",
      "<<<<<<< SEARCH",
      "Always use `npm insatll` to fetch",
      "=======",
      "Always use `npm install` to fetch",
      ">>>>>>> REPLACE",
      "```",
      "```redline:resolutions",
      '[ { "id": "c1", "action": "resolved", "note": "Fixed the typo." } ]',
      "```",
    ].join("\n");
    const parsed = parseReply(reply);
    expect(parsed.warnings).toEqual([]);
    const applied = applyEdits(doc.markdown, parsed.edits);
    expect(applied.markdown).toContain("`npm install`");
    expect(applied.outcomes[0]).toMatchObject({ status: "applied" });
  });
});
