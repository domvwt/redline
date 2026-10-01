import { afterEach, describe, expect, it, vi } from "vitest";
import { markdownToPlainBlocks } from "./plaintext.ts";
import { mapFromBaseline, mapToBaseline, trackChanges, type TrackedChange } from "./track-changes.ts";

/** each change as [removed, added, block] — what a reviewer would see */
function show(oldText: string, newText: string) {
  return trackChanges(oldText, newText).map((c: TrackedChange) => [
    oldText.slice(c.oldStart, c.oldEnd),
    newText.slice(c.newStart, c.newEnd),
    c.block,
  ]);
}

describe("trackChanges", () => {
  it("is empty for identical texts", () => {
    expect(trackChanges("a\nb", "a\nb")).toEqual([]);
  });

  it("word-diffs a revised paragraph in place", () => {
    expect(show("Title\nRun it before the start.", "Title\nRun it once, before the start.")).toEqual([
      ["", "once, ", false],
    ]);
  });

  it("keeps a new paragraph whole instead of borrowing words from a deleted one", () => {
    const before = "Intro\nRun the migrations before starting the server for the first time.";
    const after =
      "Intro\nRun the migrations once, before the server's first start.\nTroubleshooting\nIf the server fails to start, check the database.";
    const changes = show(before, after);
    // the added paragraphs arrive as whole blocks, untouched by the old line
    expect(changes).toContainEqual(["", "\nTroubleshooting\nIf the server fails to start, check the database.", true]);
    expect(changes.filter(([, , block]) => !block).every(([, added]) => !String(added).includes("fails"))).toBe(true);
  });

  it("puts surplus removals after the additions, where they fell", () => {
    expect(show("x\nYes\nfirst item\nsecond item", "x\nNo\nsecond item")).toEqual([
      ["Yes\n", "", true],
      ["", "No\n", true],
      ["first item\n", "", true],
    ]);
  });

  it("reports a deleted paragraph as a whole block", () => {
    expect(show("a\ngone entirely\nc", "a\nc")).toEqual([["gone entirely\n", "", true]]);
  });

  it("folds coincidental one-word slivers into the surrounding rewrite", () => {
    const changes = show(
      "x\nDeploy to staging and then to production after review.",
      "x\nDeploy to canary and after that to production after review.",
    );
    // "and" between two changes is not kept text
    expect(changes).toEqual([["staging and then", "canary and after that", false]]);
  });

  it("treats unrelated paragraphs as a block swap, not a word salad", () => {
    expect(show("x\nthe cat sat on the mat\ny", "x\nwe deploy every friday afternoon\ny")).toEqual([
      ["the cat sat on the mat\n", "", true],
      ["", "we deploy every friday afternoon\n", true],
    ]);
  });

  it("orders changes monotonically in both texts", () => {
    const changes = trackChanges(
      "one\ntwo old\nthree\nfour",
      "zero\none\ntwo new\nfour\nfive",
    );
    for (let n = 1; n < changes.length; n++) {
      expect(changes[n].oldStart).toBeGreaterThanOrEqual(changes[n - 1].oldEnd);
      expect(changes[n].newStart).toBeGreaterThanOrEqual(changes[n - 1].newEnd);
    }
  });

  it("handles empty texts and pure appends or truncations at the end", () => {
    expect(show("", "new text")).toEqual([["", "new text", true]]);
    expect(show("old text", "")).toEqual([["old text", "", true]]);
    expect(show("a\nb", "a\nb\nc")).toEqual([["", "\nc", true]]);
    expect(show("a\nb\nc", "a\nb")).toEqual([["\nc", "", true]]);
  });

  it("ignores a paragraph that was only re-wrapped", () => {
    const before = markdownToPlainBlocks("Intro.\n\nComments re-anchor\nwhenever an agent edits a file.\n");
    const after = markdownToPlainBlocks("Intro.\n\nComments re-anchor whenever\nan agent edits a file.\n");
    const changes = trackChanges(before.text, after.text, before, after);
    const visible = changes.filter(
      (c) =>
        before.text.slice(c.oldStart, c.oldEnd).trim() || after.text.slice(c.newStart, c.newEnd).trim(),
    );
    expect(visible).toEqual([]);
  });

  it("word-diffs inside a soft-wrapped paragraph instead of splitting it into lines", () => {
    const before = markdownToPlainBlocks("Comments re-anchor\nwhenever an agent\nedits a file.\n");
    const after = markdownToPlainBlocks("Comments re-anchor\nedits a file.\n");
    const changes = trackChanges(before.text, after.text, before, after);
    expect(changes.map((c) => [before.text.slice(c.oldStart, c.oldEnd).trim(), c.block])).toEqual([
      ["whenever an agent", false],
    ]);
  });

  it("keeps unchanged text identical between changes, so offsets map by arithmetic", () => {
    // random edits: the text outside the changes must line up exactly
    let seed = 7;
    const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) % n);
    const words = ["alpha", "beta", "gamma", "the", "a", "delta", "\n"];
    const gen = () => Array.from({ length: rand(30) }, () => words[rand(words.length)]).join(" ");
    for (let run = 0; run < 500; run++) {
      const oldText = gen();
      const newText = run % 3 ? oldText.replace(/beta|\n a/g, () => words[rand(words.length)]) + gen() : gen();
      const changes = trackChanges(oldText, newText);
      let o = 0;
      let n = 0;
      for (const c of [...changes, { oldStart: oldText.length, newStart: newText.length } as TrackedChange]) {
        expect(oldText.slice(o, c.oldStart)).toBe(newText.slice(n, c.newStart));
        o = c.oldEnd;
        n = c.newEnd;
      }
    }
  });
});

describe("mapFromBaseline", () => {
  const oldText = "one\ngone paragraph\nthree";
  const newText = "zero\none\nthree";
  const changes = trackChanges(oldText, newText);

  it("shifts offsets in unchanged text by the edits before them", () => {
    expect(newText.slice(mapFromBaseline(changes, oldText.indexOf("three")))).toBe("three");
  });

  it("puts a deleted passage where its removal shows", () => {
    expect(newText.slice(mapFromBaseline(changes, oldText.indexOf("gone")))).toBe("three");
  });

  it("maps unchanged new text back, and added text to null", () => {
    expect(oldText.slice(mapToBaseline(changes, newText.indexOf("three"))!)).toBe("three");
    expect(mapToBaseline(changes, newText.indexOf("zero"))).toBeNull();
  });
});

describe("trackChanges time budget", () => {
  afterEach(() => vi.restoreAllMocks());

  it("falls back to whole-block swaps once the word-diff budget is spent", () => {
    // every Date.now() call jumps a second: the budget is gone before the first word diff
    let t = 0;
    vi.spyOn(Date, "now").mockImplementation(() => (t += 1000));
    expect(show("x\nRun it before the start.", "x\nRun it once, before the start.")).toEqual([
      ["Run it before the start.", "Run it once, before the start.", true],
    ]);
  });

  it("bounds block alignment too, still pairing unchanged blocks", () => {
    let t = 0;
    vi.spyOn(Date, "now").mockImplementation(() => (t += 1000));
    // no time at all: the whole text is one changed run, yet unchanged
    // blocks pair off and only the real change shows
    expect(show("a\nb\nc\nd", "a\nb\nX\nd")).toEqual([["c\n", "", true], ["", "X\n", true]]);
  });

  it("still treats a re-wrapped paragraph as unchanged with no budget left", () => {
    let t = 0;
    vi.spyOn(Date, "now").mockImplementation(() => (t += 1000));
    const before = markdownToPlainBlocks("Intro.\n\nComments re-anchor\nwhenever an agent edits.\n");
    const after = markdownToPlainBlocks("Intro.\n\nComments re-anchor whenever\nan agent edits.\n");
    expect(trackChanges(before.text, after.text, before, after)).toEqual([]);
  });
});

describe("markdownToPlainBlocks", () => {
  const blocks = (md: string) => {
    const { text, blockStarts } = markdownToPlainBlocks(md);
    return blockStarts.map((s, i) => text.slice(s, blockStarts[i + 1] ?? text.length).trim());
  };

  it("starts one block per paragraph, not per soft-wrapped line", () => {
    expect(blocks("one\ntwo\n\nthree")).toEqual(["one\ntwo", "three"]);
  });

  it("starts blocks for list items, quotes, headings, code, and table cells", () => {
    expect(blocks("# Title\n\n- a\n- b\n\n> quoted\n\n```\ncode\n```\n\n| h |\n| - |\n| c |\n")).toEqual([
      "Title",
      "a",
      "b",
      "quoted",
      "code",
      "h",
      "c",
    ]);
  });
});

describe("trackChanges with block kinds", () => {
  const md = (a: string, b: string) => {
    const before = markdownToPlainBlocks(a);
    const after = markdownToPlainBlocks(b);
    return trackChanges(before.text, after.text, before, after).map((c) => [
      before.text.slice(c.oldStart, c.oldEnd).trim(),
      after.text.slice(c.newStart, c.newEnd).trim(),
      c.block,
    ]);
  };

  it("never lets a deleted paragraph stand in for a replaced table cell", () => {
    expect(
      md("Intro.\n\n| Name | Due |\n| - | - |\n| a | b |\n", "| Person | Due |\n| - | - |\n| a | b |\n"),
    ).toEqual([
      ["Intro.", "", true],
      ["Name", "Person", false],
    ]);
  });

  it("pairs a changed cell with its own column, even when unlike its old text", () => {
    expect(md("| k | v |\n| - | - |\n| a | Yes |\n", "| k | v |\n| - | - |\n| a | No |\n")).toEqual([
      ["Yes", "No", false],
    ]);
  });

  it("names kinds by nearest container", () => {
    const { blockKinds } = markdownToPlainBlocks("# H\n\np\n\n- item\n\n> q\n\n```\nc\n```\n\n| t |\n| - |\n| u |\n");
    expect(blockKinds).toEqual(["heading", "paragraph", "list", "quote", "code", "table:0", "table:0"]);
  });

  it("tells a deleted row from an edited one by the cells' spelling", () => {
    expect(
      md(
        "| n | t |\n| - | - |\n| Ann | Ops |\n| Bob | Dev |\n| Cy | QA |\n",
        "| n | t |\n| - | - |\n| Ann | Ops |\n| Cyd | QA |\n",
      ),
    ).toEqual([
      ["Bob\nDev", "", true],
      ["Cy", "Cyd", false],
    ]);
  });

  it("splits adjacent removed blocks into separate changes, keeping table rows whole", () => {
    expect(md("Keep.\n\nGone one.\n\nGone two.\n\nEnd.\n", "Keep.\n\nEnd.\n")).toEqual([
      ["Gone one.", "", true],
      ["Gone two.", "", true],
    ]);
    expect(md("Keep.\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nEnd.\n", "Keep.\n\nEnd.\n")).toEqual([
      ["a\nb\n1\n2", "", true],
    ]);
  });

  it("diffs code blocks by line, so a deleted line shows whole", () => {
    expect(md("```\nline one\nline two\nline three\n```\n", "```\nline one\nline three\n```\n")).toEqual([
      ["line two", "", false],
    ]);
  });

  it("lets a revised paragraph keep its revision from a short deleted one before it", () => {
    expect(
      md(
        "It is done.\n\nDeployment of the service is scheduled and it is expected to be done by Friday.\n",
        "Deployment of the service is scheduled; it is expected to be done by Monday.\n",
      )[0],
    ).toEqual(["It is done.", "", true]);
  });

  it("anchors unchanged paragraphs past a big insertion, even without the block diff", () => {
    let t = 0;
    vi.spyOn(Date, "now").mockImplementation(() => (t += 1000));
    const paras = Array.from({ length: 12 }, (_, k) => `Paragraph number ${k} stays put.`);
    const inserted = Array.from({ length: 10 }, (_, k) => `New section line ${k}.`);
    const before = paras.join("\n\n");
    const after = [...inserted, ...paras].join("\n\n");
    // only the insertion shows; every old paragraph found its own
    expect(md(before, after).every(([removed]) => removed === "")).toBe(true);
    vi.restoreAllMocks();
  });

  it("keeps a removed table whole when other blocks replace it", () => {
    expect(
      md("Intro.\n\n| k | v |\n| - | - |\n| host | db |\n", "Intro.\n\nOne paragraph instead.\n"),
    ).toEqual([
      ["k\nv\nhost\ndb", "", true],
      ["", "One paragraph instead.", true],
    ]);
  });

  it("falls back to a removed block's next-best revision when a later one claims its best", () => {
    const changes = md(
      "Deploy the web service to staging every Monday morning.\n\nDeploy the web service to production every Monday.\n",
      "Deploy the service to staging every Monday morning, early.\n\nDeploy the web service to production every Monday, carefully.\n",
    );
    expect(changes.every(([, , block]) => block === false)).toBe(true);
  });

  it("keeps parallel revised paragraphs each paired with its own revision", () => {
    const changes = md(
      "Staging deploys run every Monday morning after the standup.\n\nProduction deploys run every Friday afternoon after the release review.\n",
      "Staging deploys now run every Tuesday after the release review.\n\nProduction deploys run every Friday afternoon after the review.\n",
    );
    expect(changes.every(([, , block]) => block === false)).toBe(true);
  });

  it("draws a paragraph removed after a table outside the row added to it", () => {
    const changes = md(
      "| k | v |\n| - | - |\n| a | 1 |\n\nTODO: add the dev environment.\n\nEnd.\n",
      "| k | v |\n| - | - |\n| a | 1 |\n| dev | d1 |\n\nEnd.\n",
    );
    // the addition (the new row) comes before the removed paragraph
    expect(changes.map(([removed, added]) => (removed ? "-" : "+") + (removed || added))).toEqual([
      "+dev\nd1",
      "-TODO: add the dev environment.",
    ]);
  });

  it("doesn't let a fallback pairing strand the block that claimed a match", () => {
    const changes = md(
      "The pager rota is shared between the platform and data teams.\n\nThe pager rota is shared between the platform and data teams each week, with handover on Monday.\n",
      "The pager rota is shared between the platform and data teams each week, with handover on Tuesday.\n\nThe pager rota is owned by the platform team alone.\n",
    );
    expect(changes).toContainEqual(["Monday", "Tuesday", false]);
  });

  it("draws a loose rewrite under its own original, not under a deleted neighbour", () => {
    expect(
      md(
        "Comments survive edits because quotes re-anchor.\n\nTry it now and highlight this sentence to type something.\n",
        "Give it a go: pick any sentence and just start to type something.\n",
      ),
    ).toEqual([
      // the deleted neighbour stands alone; the rewrite pairs with its own original
      ["Comments survive edits because quotes re-anchor.", "", true],
      ["Try it now and highlight this", "Give it a go: pick any", false],
      ["", "and just start", false],
    ]);
  });

  it("pairs a renamed heading with the old heading past a deleted paragraph", () => {
    expect(md("This paragraph is obsolete now.\n\n## Usage\n\nRun it.\n", "## Running it\n\nRun it.\n")).toEqual([
      ["This paragraph is obsolete now.", "", true],
      ["Usage", "", true],
      ["", "Running it", true],
    ]);
  });

  it("aligns a rewrite with its original even when counts are equal", () => {
    const changes = md(
      "Obsolete note about the fax machine.\n\nThe cache is warmed at startup by the loader thread.\n",
      "Cache warming is lazy now, done by the loader on first use.\n\nQuestions go to the platform channel.\n",
    ).map(([removed, added]) => [String(removed).slice(0, 12), String(added).slice(0, 12)]);
    // the fax note stands alone; the cache paragraph sits above its rewrite;
    // the unrelated question paragraph stands alone
    expect(changes[0]).toEqual(["Obsolete not", ""]);
    expect(changes.at(-1)).toEqual(["", "Questions go"]);
  });

  it("keeps a list's struck items together above the paragraph that replaced it", () => {
    const changes = md("- alpha one\n- beta two\n- gamma three\n", "Alpha, beta and gamma, all in one line.\n");
    expect(changes.map(([removed, added]) => (removed ? "-" : "+"))).toEqual(["-", "-", "-", "+"]);
  });

  it("pairs a renamed heading past a newly added paragraph", () => {
    const changes = md(
      "## Overview\n\nRedline is a review tool.\n\n## Setup\n\nRun npm install.\n",
      "## Overview\n\nRedline is a review tool.\n\nIt works with any editor.\n\n## Installation\n\nRun npm install.\n",
    );
    expect(changes).toEqual([
      ["", "It works with any editor.", true],
      ["Setup", "", true],
      ["", "Installation", true],
    ]);
  });

  it("pairs a renamed heading with the old one when a paragraph before it was deleted and one after added", () => {
    const changes = md(
      "Old lead paragraph about widgets.\n\n## Setup\n\nKeep.\n",
      "## Installation\n\nFresh text on gadgets.\n\nKeep.\n",
    );
    expect(changes).toEqual([
      ["Old lead paragraph about widgets.", "", true],
      ["Setup", "", true],
      ["", "Installation", true],
      ["", "Fresh text on gadgets.", true],
    ]);
  });

  it("draws a paragraph rewritten as a list above the list, not inside it", () => {
    const changes = md(
      "We deploy on Mondays, run the smoke tests, and page the on-call engineer if anything fails.\n",
      "- Mondays are release days\n- Run the smoke tests and page the on-call engineer if anything fails\n- Keep the log\n\nQuestions go to the platform channel.\n",
    );
    // the removal comes first, at the list's start
    expect(changes[0][0]).toBe("We deploy on Mondays, run the smoke tests, and page the on-call engineer if anything fails.");
    expect(changes[0][1]).toBe("");
  });

  it("pairs a paragraph trimmed hard with its old self", () => {
    expect(
      md(
        "We ship weekly, except during the December freeze when nothing ships at all, and hotfixes go out daily.\n",
        "We ship weekly, and hotfixes go out daily.\n",
      ).every(([, , block]) => block === false),
    ).toBe(true);
  });

  it("matches revised paragraphs through punctuation", () => {
    // "tests." and "tests," are the same word; without that, this is a swap
    expect(md("Intro.\n\nRun the tests.\n", "Intro.\n\nRun the tests, then deploy.\n")).toEqual([
      ["", ", then deploy", false],
    ]);
  });
});
