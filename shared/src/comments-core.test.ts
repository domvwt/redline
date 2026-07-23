import { describe, expect, it } from "vitest";
import {
  applyAuthorPatch,
  authorReply,
  emptySidecar,
  newAnnotation,
  proposeResolution,
  reanchorAnnotations,
  snapshotPriorQuotes,
} from "./comments-core.ts";

describe("priorQuote lifecycle", () => {
  it("survives the addressed state and clears when a rejection reopens the comment", () => {
    const a = newAnnotation("c1", "tighten this", {
      quote: { exact: "old passage", prefix: "the ", suffix: " here" },
      position: { start: 4, end: 15 },
    });
    // the apply flow snapshots the pre-revision passage, then proposes
    a.priorQuote = { type: "TextQuoteSelector", exact: "old passage", prefix: "the ", suffix: " here" };
    proposeResolution(a, "resolved", "reworded it");
    expect(a.status).toBe("addressed");
    expect(a.priorQuote?.exact).toBe("old passage");

    const { wasClosed } = authorReply(a, "no — keep the original phrasing");
    expect(wasClosed).toBe(true);
    expect(a.status).toBe("open");
    expect(a.priorQuote).toBeNull();
    // the agent's note is preserved as thread history, not lost
    expect(a.replies?.[0]).toMatchObject({ by: "claude", text: "reworded it", action: "resolved" });
  });

  it("keeps the first snapshot across an agent pass's multiple writes", () => {
    const sidecar = emptySidecar("doc.md");
    const a = newAnnotation("c1", "tighten", {
      quote: { exact: "first wording", prefix: "", suffix: "" },
      position: { start: 0, end: 13 },
    });
    sidecar.annotations.push(a);

    expect(snapshotPriorQuotes(sidecar)).toBe(true);
    expect(a.priorQuote?.exact).toBe("first wording");

    // re-anchoring between writes rewrites the live quote…
    a.target!.selector[0].exact = "intermediate wording";
    // …but the second write of the same pass must not move the comparison point
    expect(snapshotPriorQuotes(sidecar)).toBe(false);
    expect(a.priorQuote?.exact).toBe("first wording");
  });

  it("marks a proposal on an orphaned comment as anchor-lost, cleared on reopen", () => {
    const a = newAnnotation("c1", "fix this", {
      quote: { exact: "gone passage", prefix: "", suffix: "" },
      position: { start: 0, end: 12 },
    });
    a.status = "orphaned";
    proposeResolution(a, "resolved", "rewrote the whole section");
    expect(a.status).toBe("addressed");
    expect(a.anchorLost).toBe(true);

    authorReply(a, "please keep the original structure");
    expect(a.status).toBe("open");
    expect(a.anchorLost).toBeUndefined();
  });
});

describe("reanchorAnnotations with a certified prior text", () => {
  const OLD = "hi my name is dominic";
  const NEW = "hi I am called dominic";

  const commentOn = (plain: string, exact: string) => {
    const start = plain.indexOf(exact);
    return newAnnotation("c1", "note", {
      quote: {
        exact,
        prefix: plain.slice(Math.max(0, start - 32), start),
        suffix: plain.slice(start + exact.length, start + exact.length + 32),
      },
      position: { start, end: start + exact.length },
    });
  };

  it("follows a full rephrase the quote ladder cannot find", () => {
    const sidecar = emptySidecar("doc.md");
    const a = commentOn(OLD, "my name is");
    sidecar.annotations.push(a);
    snapshotPriorQuotes(sidecar);

    const orphans = reanchorAnnotations(sidecar, NEW, "h2", undefined, OLD);

    expect(orphans).toBe(0);
    expect(a.status).toBe("open");
    expect(a.target?.selector[0].exact).toBe("I am called");
    // the was/now review pair the UI renders
    expect(a.priorQuote?.exact).toBe("my name is");
  });

  it("orphans the same rephrase without the prior text (regression baseline)", () => {
    const sidecar = emptySidecar("doc.md");
    const a = commentOn(OLD, "my name is");
    sidecar.annotations.push(a);

    reanchorAnnotations(sidecar, NEW, "h2");

    expect(a.status).toBe("orphaned");
  });

  it("still finds a passage that moved rather than changed", () => {
    const oldText = "The cat sat quietly. Dogs bark loudly at night.";
    const newText = "Dogs bark loudly at night. The cat sat quietly.";
    const sidecar = emptySidecar("doc.md");
    const a = commentOn(oldText, "Dogs bark loudly");
    sidecar.annotations.push(a);

    const orphans = reanchorAnnotations(sidecar, newText, "h2", undefined, oldText);

    expect(orphans).toBe(0);
    expect(a.target?.selector[0].exact).toBe("Dogs bark loudly");
    expect(newText.slice(a.target!.selector[1].start, a.target!.selector[1].end)).toBe(
      "Dogs bark loudly",
    );
  });

  it("prefers the ladder when the passage moved and a decoy took its place", () => {
    // a word diff aligns on shared stopwords ("the", "fox"), so mapping the
    // old span through it would land on the decoy — the ladder's exact hit
    // with full context agreement must win
    const A =
      "This opening paragraph provides plenty of stable surrounding context for the diff to align on, sentence after sentence of it.";
    const B =
      "This closing paragraph likewise provides a long run of untouched words that anchor the alignment at the other end.";
    const oldText = `${A} The quick brown fox jumps over the lazy dog. ${B}`;
    const newText = `${A} Something about the sly red fox and the sleeping hound today. ${B} The quick brown fox jumps over the lazy dog.`;
    const sidecar = emptySidecar("doc.md");
    const a = commentOn(oldText, "quick brown fox");
    sidecar.annotations.push(a);

    const orphans = reanchorAnnotations(sidecar, newText, "h2", undefined, oldText);

    expect(orphans).toBe(0);
    expect(a.target?.selector[0].exact).toBe("quick brown fox");
    const pos = a.target!.selector[1];
    expect(newText.slice(pos.start, pos.end)).toBe("quick brown fox");
    // …at the moved location after B, not in the decoy sentence
    expect(pos.start).toBeGreaterThan(newText.indexOf(B));
  });

  it("clears priorQuote when a note-less self-resolve is reopened by reply", () => {
    const a = commentOn(OLD, "my name is");
    a.priorQuote = { ...a.target!.selector[0] };
    a.status = "resolved"; // author closed it themselves, no resolution note

    authorReply(a, "actually, revisit this");

    expect(a.status).toBe("open");
    expect(a.priorQuote).toBeNull();
  });

  it("clears revision marks when the author re-anchors by hand", () => {
    const a = commentOn(OLD, "my name is");
    a.status = "orphaned";
    a.priorQuote = { ...a.target!.selector[0] };
    a.anchorLost = true;

    applyAuthorPatch(a, {
      selector: {
        quote: { exact: "dominic", prefix: "hi my name is ", suffix: "" },
        position: { start: 14, end: 21 },
      },
    });

    expect(a.status).toBe("open");
    expect(a.priorQuote).toBeNull();
    expect(a.anchorLost).toBeUndefined();
  });

  it("skips diff mapping when stored positions no longer reproduce the quote", () => {
    const sidecar = emptySidecar("doc.md");
    const a = commentOn(OLD, "my name is");
    a.target!.selector[1].start += 2; // stale position from an older doc state
    sidecar.annotations.push(a);

    reanchorAnnotations(sidecar, NEW, "h2", undefined, OLD);

    // positions were not trusted, so the ladder ran and (correctly) orphaned
    expect(a.status).toBe("orphaned");
  });
});
