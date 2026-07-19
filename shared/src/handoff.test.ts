import { describe, expect, it } from "vitest";
import {
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
    expect(prompt).toContain("`- [<id>] resolved: <what you changed>`");
    expect(prompt).toContain("`- [<id>] declined: <why not>`");
    expect(prompt).toContain("AT LEAST four backticks");
    expect(prompt).toContain("````redline:document docs/example.md");
    expect(prompt).toContain("- [c1] resolved: Fixed the typo in the install command.");
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

describe("parseReply", () => {
  it("parses a well-formed reply: three response-line variants and one document", () => {
    const reply = [
      "Happy to help — here is my review.",
      "",
      "- [c1] resolved: Reworded the intro for clarity.",
      "- c2 — declined: The number is right as written.",
      "- **[c3]** Resolved: Covered by the c1 rewording.",
      "",
      "````redline:document docs/a.md",
      "# Title",
      "",
      "Reworded body text.",
      "````",
    ].join("\n");
    const parsed = parseReply(reply);
    expect(parsed.responses).toEqual([
      { id: "c1", action: "resolved", note: "Reworded the intro for clarity." },
      { id: "c2", action: "declined", note: "The number is right as written." },
      { id: "c3", action: "resolved", note: "Covered by the c1 rewording." },
    ]);
    expect(parsed.documents).toEqual([
      { path: "docs/a.md", markdown: "# Title\n\nReworded body text." },
    ]);
    expect(parsed.warnings).toEqual([]);
  });

  it("keeps three-backtick code fences intact inside a four-backtick document block", () => {
    const reply = [
      "- [c1] resolved: Updated the example.",
      "",
      "````redline:document docs/code.md",
      "# Code",
      "",
      "```js",
      "renewed();",
      "```",
      "````",
    ].join("\n");
    const parsed = parseReply(reply);
    expect(parsed.documents).toEqual([
      { path: "docs/code.md", markdown: "# Code\n\n```js\nrenewed();\n```" },
    ]);
    expect(parsed.warnings).toEqual([]);
  });

  it("drops an unterminated document block with a truncation warning", () => {
    const reply = [
      "- [c1] resolved: Rewrote the intro.",
      "",
      "````redline:document docs/a.md",
      "# Title",
      "Half of the docum",
    ].join("\n");
    const parsed = parseReply(reply);
    expect(parsed.documents).toEqual([]);
    expect(parsed.responses).toHaveLength(1);
    expect(parsed.warnings.some((w) => w.includes("truncated") && w.includes("docs/a.md"))).toBe(
      true,
    );
  });

  it("parses two document blocks", () => {
    const reply = [
      "- [c1] resolved: Fixed both files.",
      "",
      "````redline:document docs/a.md",
      "Revised A.",
      "````",
      "",
      "````redline:document docs/b.md",
      "Revised B.",
      "````",
    ].join("\n");
    const parsed = parseReply(reply);
    expect(parsed.documents).toEqual([
      { path: "docs/a.md", markdown: "Revised A." },
      { path: "docs/b.md", markdown: "Revised B." },
    ]);
    expect(parsed.warnings).toEqual([]);
  });

  it("attributes a lone untagged fenced block to defaultPath with a warning", () => {
    const body = "# Guide\n\n" + "This paragraph pads the block to document-like size. ".repeat(5);
    const reply = ["- [c1] resolved: Rewrote the guide.", "", "```", body, "```"].join("\n");
    const parsed = parseReply(reply, { defaultPath: "docs/guide.md" });
    expect(parsed.documents).toEqual([{ path: "docs/guide.md", markdown: body }]);
    expect(parsed.warnings.some((w) => w.includes("assuming") && w.includes("docs/guide.md"))).toBe(
      true,
    );
  });

  it("refuses the untagged fallback when several blocks could be the document", () => {
    const big = "x".repeat(210);
    const reply = ["- [c1] resolved: ok.", "```", big, "```", "", "```", big, "```"].join("\n");
    const parsed = parseReply(reply, { defaultPath: "docs/a.md" });
    expect(parsed.documents).toEqual([]);
    expect(parsed.warnings.some((w) => w.includes("multiple untagged"))).toBe(true);
  });

  it("ignores small untagged blocks and never guesses without a defaultPath", () => {
    const small = ["- [c1] resolved: ok.", "```", "tiny", "```"].join("\n");
    expect(parseReply(small, { defaultPath: "docs/a.md" }).documents).toEqual([]);
    const big = ["- [c1] resolved: ok.", "```", "x".repeat(210), "```"].join("\n");
    expect(parseReply(big).documents).toEqual([]);
  });

  it("parses a reply the chat UI wrapped in one outer fence", () => {
    const reply = [
      "```",
      "- [c1] resolved: Reworded.",
      "",
      "````redline:document docs/a.md",
      "New body content.",
      "````",
      "```",
    ].join("\n");
    const parsed = parseReply(reply);
    expect(parsed.documents).toEqual([{ path: "docs/a.md", markdown: "New body content." }]);
    expect(parsed.responses).toEqual([{ id: "c1", action: "resolved", note: "Reworded." }]);
  });

  it("returns a fence-imbalanced document but warns about it", () => {
    const reply = [
      "- [c1] resolved: Added an example.",
      "",
      "````redline:document docs/a.md",
      "# Title",
      "```js",
      "code();",
      "````",
    ].join("\n");
    const parsed = parseReply(reply);
    expect(parsed.documents).toEqual([{ path: "docs/a.md", markdown: "# Title\n```js\ncode();" }]);
    expect(parsed.warnings.some((w) => w.includes("unbalanced") && w.includes("docs/a.md"))).toBe(
      true,
    );
  });

  it("normalizes loose action synonyms and skips unknown actions with a warning", () => {
    const reply = [
      "- [c1] done: n1",
      "- [c2] wontfix: n2",
      "- [c3] maybe: n3",
      "- [c4] resolved",
    ].join("\n");
    const parsed = parseReply(reply);
    expect(parsed.responses).toEqual([
      { id: "c1", action: "resolved", note: "n1" },
      { id: "c2", action: "declined", note: "n2" },
      { id: "c4", action: "resolved", note: "" },
    ]);
    expect(parsed.warnings.some((w) => w.includes('unknown response action "maybe"'))).toBe(true);
  });

  it("falls back to a redline:resolutions JSON block when there are no response lines", () => {
    const reply = [
      "```redline:resolutions",
      "Here you go:",
      '[ { "id": "c1", "action": "resolved", "note": "Done [see the intro]." } ]',
      "```",
    ].join("\n");
    const parsed = parseReply(reply);
    expect(parsed.responses).toEqual([
      { id: "c1", action: "resolved", note: "Done [see the intro]." },
    ]);
  });

  it("accepts a plain fenced JSON array shaped like responses", () => {
    const reply = ["```json", '[ { "id": "c1", "action": "done", "note": "ok" } ]', "```"].join(
      "\n",
    );
    const parsed = parseReply(reply);
    expect(parsed.responses).toEqual([{ id: "c1", action: "resolved", note: "ok" }]);
  });

  it("never treats the JSON responses block as the untagged document", () => {
    const entries = Array.from({ length: 6 }, (_, i) => {
      return `  { "id": "c${i}", "action": "resolved", "note": "a long note to pad the block out" }`;
    });
    const reply = ["```redline:resolutions", "[", entries.join(",\n"), "]", "```"].join("\n");
    const parsed = parseReply(reply, { defaultPath: "docs/a.md" });
    expect(parsed.documents).toEqual([]);
    expect(parsed.responses).toHaveLength(6);
  });

  it("warns about malformed responses JSON instead of throwing", () => {
    const reply = ["```redline:resolutions", '[ { "id": "c1" "action" } ]', "```"].join("\n");
    const parsed = parseReply(reply);
    expect(parsed.responses).toEqual([]);
    expect(parsed.warnings.some((w) => w.includes("malformed JSON"))).toBe(true);
  });

  it("warns when the reply contains no responses at all", () => {
    const parsed = parseReply("Sure, happy to help with that!");
    expect(parsed.documents).toEqual([]);
    expect(parsed.responses).toEqual([]);
    expect(parsed.warnings.some((w) => w.includes("no comment responses"))).toBe(true);
  });

  it("does not mistake ordinary prose for response lines", () => {
    const reply = [
      "Overall the piece reads well: nice work.",
      "- The second point — however: needs thought.",
      "- [c1] resolved: The only real response here.",
    ].join("\n");
    const parsed = parseReply(reply);
    expect(parsed.responses).toEqual([
      { id: "c1", action: "resolved", note: "The only real response here." },
    ]);
  });
});

describe("round trip", () => {
  it("a reply written against the generated prompt parses back cleanly", () => {
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

    const revised = "# Guide\n\nAlways use `npm install` to fetch dependencies.\n";
    const reply = [
      "- [c1] resolved: Fixed the typo in the install command.",
      "",
      "````redline:document docs/guide.md",
      revised,
      "````",
    ].join("\n");
    const parsed = parseReply(reply);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.responses).toEqual([
      { id: "c1", action: "resolved", note: "Fixed the typo in the install command." },
    ]);
    expect(parsed.documents).toEqual([{ path: "docs/guide.md", markdown: revised }]);
  });
});
