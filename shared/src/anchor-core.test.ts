import { describe, expect, it } from "vitest";
import { makeQuoteSelector, resolveAnchor } from "./anchor-core.ts";
import { markdownToPlainText } from "./plaintext.ts";
import type { Annotation } from "./types.ts";

function annotationFor(text: string, start: number, end: number): Annotation {
  return {
    id: "a1",
    created: "2026-01-01T00:00:00Z",
    modified: "2026-01-01T00:00:00Z",
    body: { type: "TextualBody", value: "test comment" },
    target: {
      selector: [
        makeQuoteSelector(text, start, end),
        { type: "TextPositionSelector", start, end },
      ],
    },
    status: "open",
    resolution: null,
  };
}

const DOC = [
  "The quick brown fox jumps over the lazy dog.",
  "A second paragraph mentions the lazy dog again in passing.",
  "The final paragraph is about something else entirely.",
].join("\n");

describe("resolveAnchor", () => {
  it("uses the position hint when the doc hash is valid", () => {
    const start = DOC.indexOf("quick brown fox");
    const ann = annotationFor(DOC, start, start + 15);
    const r = resolveAnchor(DOC, ann, { positionHintValid: true });
    expect(r).toMatchObject({ start, end: start + 15, method: "position" });
  });

  it("falls back to exact search when a certified hint no longer reproduces the quote", () => {
    // A docHash-valid hint can still be stale if the plain-text extraction
    // rules changed since it was stored (hash covers the doc, not the domain).
    const start = DOC.indexOf("quick brown fox");
    const ann = annotationFor(DOC, start, start + 15);
    ann.target!.selector[1].start = start - 2; // drifted hint, same doc
    ann.target!.selector[1].end = start + 13;
    const r = resolveAnchor(DOC, ann, { positionHintValid: true });
    expect(r).toMatchObject({ start, end: start + 15, method: "exact" });
  });

  it("finds an exact unique quote after text is inserted before it", () => {
    const start = DOC.indexOf("final paragraph");
    const ann = annotationFor(DOC, start, start + 15);
    const edited = "A brand new opening paragraph.\n" + DOC;
    const r = resolveAnchor(edited, ann);
    expect(r?.method).toBe("exact");
    expect(edited.slice(r!.start, r!.end)).toBe("final paragraph");
  });

  it("disambiguates duplicate quotes via context", () => {
    // annotate the SECOND "lazy dog"
    const first = DOC.indexOf("lazy dog");
    const second = DOC.indexOf("lazy dog", first + 1);
    const ann = annotationFor(DOC, second, second + 8);
    const r = resolveAnchor(DOC, ann);
    expect(r?.start).toBe(second);
  });

  it("fuzzy-matches after small rewording inside the quote", () => {
    const start = DOC.indexOf("second paragraph mentions the lazy dog");
    const ann = annotationFor(DOC, start, start + 38);
    const edited = DOC.replace(
      "second paragraph mentions the lazy dog",
      "second paragraph mentioned the lazy dog",
    );
    const r = resolveAnchor(edited, ann);
    expect(r?.method).toBe("fuzzy");
    expect(edited.slice(r!.start, r!.end)).toContain("lazy dog");
  });

  it("orphans when the passage is deleted", () => {
    const start = DOC.indexOf("something else entirely");
    const ann = annotationFor(DOC, start, start + 23);
    const edited = DOC.replace("The final paragraph is about something else entirely.", "Short.");
    const r = resolveAnchor(edited, ann);
    expect(r).toBeNull();
  });

  it("survives an edit adjacent to the quote", () => {
    const start = DOC.indexOf("jumps over");
    const ann = annotationFor(DOC, start, start + 10);
    const edited = DOC.replace("the lazy dog.", "the extremely lazy dog.");
    const r = resolveAnchor(edited, ann);
    expect(edited.slice(r!.start, r!.end)).toBe("jumps over");
  });

  it("prefers a contextful fuzzy site over a verbatim copy with alien context", () => {
    const original = [
      "Intro paragraph with some setup text.",
      "The final answer is 42, which we computed carefully.",
      "Closing remarks go here.",
    ].join("\n");
    const start = original.indexOf("answer is 42");
    const ann = annotationFor(original, start, start + 12);
    // the annotated passage is lightly edited, and a note elsewhere quotes
    // the OLD wording verbatim — the copy must not steal the anchor
    const edited =
      original.replace("answer is 42", "answer is 43") + "\nNote: answer is 42 was wrong.";
    const r = resolveAnchor(edited, ann);
    expect(r?.method).toBe("fuzzy");
    expect(edited.slice(r!.start, r!.end)).toBe("answer is 43");
  });

  it("keeps the exact match when no fuzzy candidate has strong context", () => {
    // same verbatim copy, but the true site is deleted outright: the copy is
    // the only plausible home, so the exact tier must still win
    const original = [
      "Intro paragraph with some setup text.",
      "The final answer is 42, which we computed carefully.",
      "Closing remarks go here.",
    ].join("\n");
    const start = original.indexOf("answer is 42");
    const ann = annotationFor(original, start, start + 12);
    const edited =
      original.replace("The final answer is 42, which we computed carefully.\n", "") +
      "\nNote: answer is 42 was wrong.";
    const r = resolveAnchor(edited, ann);
    expect(r?.method).toBe("exact");
    expect(edited.slice(r!.start, r!.end)).toBe("answer is 42");
  });

  it("rescues the true site when a decoy has fewer fuzzy errors but wrong context", () => {
    const doc = [
      "Alpha section: the quick brown fox ends here.",
      "Filler paragraph to keep the two sites well apart.",
      "Omega section: the quick brown fox ends there.",
    ].join("\n");
    // annotate the SECOND occurrence
    const first = doc.indexOf("the quick brown fox");
    const second = doc.indexOf("the quick brown fox", first + 1);
    const ann = annotationFor(doc, second, second + 19);
    // both occurrences edited: the decoy gets ONE error, the true site TWO —
    // a minimum-error-only search would only ever see the decoy
    const edited = doc
      .replace("Alpha section: the quick brown fox", "Alpha section: the quick brwn fox")
      .replace("Omega section: the quick brown fox", "Omega section: the qwick brown fx");
    const r = resolveAnchor(edited, ann);
    expect(r?.method).toBe("fuzzy");
    expect(edited.slice(r!.start, r!.end)).toBe("the qwick brown fx");
  });

  it("snaps fuzzy match boundaries so surrogate pairs never split", () => {
    const original = "abc \u{1F600}";
    const ann = annotationFor(original, 0, original.length);
    const edited = "abc \u{1F601}";
    const r = resolveAnchor(edited, ann);
    expect(r?.method).toBe("fuzzy");
    const slice = edited.slice(r!.start, r!.end);
    // must not end on a lone high surrogate (or start on a lone low one)
    expect(/[\uD800-\uDBFF]$/.test(slice)).toBe(false);
    expect(/^[\uDC00-\uDFFF]/.test(slice)).toBe(false);
  });
});

describe("markdownToPlainText", () => {
  it("strips inline formatting but keeps text", () => {
    const md = "# Title\n\nSome **bold** and *italic* and `code` text.";
    const text = markdownToPlainText(md);
    expect(text).toContain("Title");
    expect(text).toContain("Some bold and italic and code text.");
    expect(text).not.toContain("**");
  });

  it("separates blocks with newlines", () => {
    const md = "First para.\n\nSecond para.\n\n- item one\n- item two";
    const text = markdownToPlainText(md);
    expect(text).toMatch(/First para\.\nSecond para\.\nitem one\nitem two/);
  });

  it("quotes spanning inline formatting are contiguous in plain text", () => {
    const md = "The **quick brown** fox jumps.";
    const text = markdownToPlainText(md);
    expect(text).toContain("The quick brown fox jumps.");
  });

  it("normalizes CRLF and lone CR so \\r never reaches the text domain", () => {
    // the editor's OffsetIndex only ever emits \n — the server must agree
    expect(markdownToPlainText("line one\r\nline two")).toBe(
      markdownToPlainText("line one\nline two"),
    );
    expect(markdownToPlainText("para one\r\n\r\npara two")).toBe("para one\npara two");
    expect(markdownToPlainText("a\rb")).toBe("a\nb");
  });
});
