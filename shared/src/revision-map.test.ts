import { describe, expect, it } from "vitest";
import { createSpanMapper } from "./revision-map.ts";

const OLD = "hi my name is dominic";
const NEW = "hi I am called dominic";

describe("createSpanMapper", () => {
  it("maps a rewritten-in-place span to its replacement", () => {
    const map = createSpanMapper(OLD, NEW);
    const span = map(3, 13); // "my name is"
    expect(span).not.toBeNull();
    expect(NEW.slice(span!.start, span!.end)).toBe("I am called");
  });

  it("maps an unchanged span by offset arithmetic across nearby edits", () => {
    const map = createSpanMapper(OLD, NEW);
    const span = map(14, 21); // " dominic" tail, shifted by the rewrite
    expect(NEW.slice(span!.start, span!.end)).toBe("dominic");
  });

  it("stretches a span straddling a change to cover the full replacement", () => {
    const map = createSpanMapper(OLD, NEW);
    const span = map(0, 13); // "hi my name is"
    expect(NEW.slice(span!.start, span!.end)).toBe("hi I am called");
  });

  it("returns null for a span deleted with nothing in its place", () => {
    const map = createSpanMapper("keep this. drop that. keep more.", "keep this. keep more.");
    expect(map(11, 21)).toBeNull(); // "drop that."
  });

  it("keeps an insertion at the span boundary outside the span", () => {
    const map = createSpanMapper("alpha beta", "alpha shiny beta");
    const span = map(6, 10); // "beta"
    expect("alpha shiny beta".slice(span!.start, span!.end)).toBe("beta");
  });

  it("rejects spans absorbed into a whole-document rewrite", () => {
    const oldText = "short note. ".repeat(30) + "the target words. " + "short note. ".repeat(30);
    const newText = "entirely different content with no overlap whatsoever, ".repeat(20);
    const map = createSpanMapper(oldText, newText);
    const start = oldText.indexOf("the target words.");
    expect(map(start, start + "the target words.".length)).toBeNull();
  });

  it("rejects out-of-range and empty spans", () => {
    const map = createSpanMapper(OLD, NEW);
    expect(map(-1, 5)).toBeNull();
    expect(map(5, 5)).toBeNull();
    expect(map(0, OLD.length + 1)).toBeNull();
  });
});
