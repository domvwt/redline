import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { markdownToPlainText, type Annotation, type Sidecar } from "@redline/shared";
import { makeQuoteSelector } from "@redline/shared";
import { reanchorFile } from "./anchoring.ts";
import { listOpenComments, resolveComment } from "./comments-service.ts";
import { DocStore } from "./docs.ts";
import { EventHub } from "./events.ts";
import { buildApp } from "./routes.ts";

const DOC = `# Guide

The quick brown fox jumps over the lazy dog.

A second paragraph explains the setup in some detail.

The final paragraph is about conclusions.
`;

let root: string;
let docs: DocStore;
let hub: EventHub;
let app: Hono;
let events: unknown[];

async function api(method: string, url: string, body?: unknown) {
  const res = await app.request(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: res.status !== 204 ? await res.json() : null };
}

async function createComment(quoteText: string, comment: string): Promise<Annotation> {
  const plain = markdownToPlainText(DOC);
  const start = plain.indexOf(quoteText);
  expect(start).toBeGreaterThanOrEqual(0);
  const quote = makeQuoteSelector(plain, start, start + quoteText.length);
  const { json } = await api("POST", "/api/comments", {
    path: "guide.md",
    body: comment,
    selector: {
      quote: { exact: quote.exact, prefix: quote.prefix, suffix: quote.suffix },
      position: { start, end: start + quoteText.length },
    },
  });
  return json as Annotation;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "redline-test-"));
  await fs.writeFile(path.join(root, "guide.md"), DOC);
  docs = new DocStore(root);
  hub = new EventHub();
  events = [];
  hub.subscribe((e) => events.push(e));
  app = buildApp(docs, hub);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("doc + comments API", () => {
  it("lists markdown files with open-comment counts", async () => {
    await createComment("quick brown fox", "why a fox?");
    const { json } = await api("GET", "/api/tree");
    expect(json).toEqual([{ path: "guide.md", name: "guide.md", openComments: 1 }]);
  });

  it("rejects path traversal", async () => {
    const res = await api("GET", "/api/doc?path=../secret.md");
    expect(res.status).toBe(400);
  });

  it("round-trips a comment through the sidecar", async () => {
    const ann = await createComment("lazy dog", "idiom is overused");
    const { json } = await api("GET", "/api/comments?path=guide.md");
    const sidecar = json as Sidecar;
    expect(sidecar.annotations).toHaveLength(1);
    expect(sidecar.annotations[0].id).toBe(ann.id);
    expect(sidecar.annotations[0].target!.selector[0].exact).toBe("lazy dog");
  });

  it("PUT /api/doc with stale hash returns 409", async () => {
    const res = await api("PUT", "/api/doc", {
      path: "guide.md",
      markdown: "changed",
      baseHash: "sha256:stale",
    });
    expect(res.status).toBe(409);
  });

  it("PUT /api/doc saves and re-anchors via client anchors", async () => {
    const ann = await createComment("final paragraph", "tighten this");
    const { json: doc } = await api("GET", "/api/doc?path=guide.md");
    const newDoc = "New intro line.\n\n" + DOC;
    const newPlain = markdownToPlainText(newDoc);
    const start = newPlain.indexOf("final paragraph");
    const res = await api("PUT", "/api/doc", {
      path: "guide.md",
      markdown: newDoc,
      baseHash: (doc as { hash: string }).hash,
      anchors: [{ id: ann.id, start, end: start + 15 }],
    });
    expect(res.status).toBe(200);
    const { json } = await api("GET", "/api/comments?path=guide.md");
    const stored = (json as Sidecar).annotations[0];
    expect(stored.target!.selector[1]).toMatchObject({ start, end: start + 15 });
    expect(stored.status).toBe("open");
  });
});

describe("terminal-Claude workflow (external edits + resolution)", () => {
  it("re-anchors comments after an external edit to the doc", async () => {
    const ann = await createComment("second paragraph", "clarify");
    // Claude edits the file from the terminal:
    const edited = DOC.replace("# Guide", "# The Complete Guide");
    await fs.writeFile(path.join(root, "guide.md"), edited);
    await reanchorFile(docs, "guide.md", hub); // what the watcher runs

    const { json } = await api("GET", "/api/comments?path=guide.md");
    const stored = (json as Sidecar).annotations.find((a) => a.id === ann.id)!;
    expect(stored.status).toBe("open");
    const plain = markdownToPlainText(edited);
    expect(
      plain.slice(stored.target!.selector[1].start, stored.target!.selector[1].end),
    ).toBe("second paragraph");
  });

  it("orphans a comment whose passage was deleted externally", async () => {
    const ann = await createComment("conclusions", "expand on this");
    const edited = DOC.replace("The final paragraph is about conclusions.\n", "");
    await fs.writeFile(path.join(root, "guide.md"), edited);
    const orphans = await reanchorFile(docs, "guide.md", hub);
    expect(orphans).toBe(1);

    const { json } = await api("GET", "/api/comments?path=guide.md");
    expect((json as Sidecar).annotations.find((a) => a.id === ann.id)!.status).toBe("orphaned");
  });

  it("exposes open comments and accepts resolutions via the MCP service", async () => {
    const a1 = await createComment("quick brown fox", "too cliché, pick a fresher image");
    const a2 = await createComment("in some detail", "DECLINE-worthy vagueness");

    const open = await listOpenComments(docs);
    expect(open.map((c) => c.id).sort()).toEqual([a1.id, a2.id].sort());
    expect(open[0].path).toBe("guide.md");

    await resolveComment(docs, hub, {
      path: "guide.md",
      id: a1.id,
      action: "resolved",
      note: "Replaced with a fresher image.",
    });
    await resolveComment(docs, hub, {
      path: "guide.md",
      id: a2.id,
      action: "declined",
      note: "The detail level is appropriate here.",
    });

    const { json } = await api("GET", "/api/comments?path=guide.md");
    const sidecar = json as Sidecar;
    const s1 = sidecar.annotations.find((a) => a.id === a1.id)!;
    const s2 = sidecar.annotations.find((a) => a.id === a2.id)!;
    // Claude only proposes: both actions land in "addressed", awaiting the author
    expect(s1.status).toBe("addressed");
    expect(s1.resolution).toEqual({ action: "resolved", note: "Replaced with a fresher image." });
    expect(s2.status).toBe("addressed");
    expect(s2.resolution?.action).toBe("declined");

    // pending proposals are not re-listed for Claude
    const remaining = await listOpenComments(docs);
    expect(remaining).toEqual([]);
  });

  it("full loop: comment -> Claude edits passage + resolves -> re-anchor survivors", async () => {
    const target = await createComment("quick brown fox", "modernize this idiom");
    const bystander = await createComment("second paragraph", "keep an eye on this");

    // Claude rewrites the commented passage and resolves the comment
    const edited = DOC.replace(
      "The quick brown fox jumps over the lazy dog.",
      "A sleek delivery drone glides over the sleeping dog.",
    );
    await fs.writeFile(path.join(root, "guide.md"), edited);
    await reanchorFile(docs, "guide.md", hub);
    await resolveComment(docs, hub, {
      path: "guide.md",
      id: target.id,
      action: "resolved",
      note: "Swapped the idiom for a modern image.",
    });

    const { json } = await api("GET", "/api/comments?path=guide.md");
    const sidecar = json as Sidecar;
    expect(sidecar.annotations.find((a) => a.id === target.id)!.status).toBe("addressed");
    const surv = sidecar.annotations.find((a) => a.id === bystander.id)!;
    expect(surv.status).toBe("open");
    const plain = markdownToPlainText(edited);
    expect(plain.slice(surv.target!.selector[1].start, surv.target!.selector[1].end)).toBe(
      "second paragraph",
    );
    expect(events.some((e) => (e as { type: string }).type === "comments:changed")).toBe(true);
  });
});

describe("notes, replies, change review, search", () => {
  it("document and project notes: create unanchored, list via MCP service, resolve", async () => {
    const docNote = await api("POST", "/api/comments", {
      path: "guide.md",
      body: "This document needs a troubleshooting section.",
    });
    expect(docNote.status).toBe(201);
    expect((docNote.json as Annotation).target).toBeNull();

    const projNote = await api("POST", "/api/comments", {
      path: "__project__",
      body: "Add a deployment guide covering rollback.",
    });
    expect(projNote.status).toBe(201);

    const open = await listOpenComments(docs);
    const proj = open.find((c) => c.path === "__project__")!;
    expect(proj.quote).toBeNull();
    expect(proj.comment).toContain("deployment guide");

    await resolveComment(docs, hub, {
      path: "__project__",
      id: (projNote.json as Annotation).id,
      action: "resolved",
      note: "Created guides/deployment.md.",
    });
    const remaining = await listOpenComments(docs);
    expect(remaining.find((c) => c.path === "__project__")).toBeUndefined();
  });

  it("unanchored notes survive re-anchoring untouched", async () => {
    await api("POST", "/api/comments", { path: "guide.md", body: "doc-wide note" });
    await fs.writeFile(path.join(root, "guide.md"), "totally rewritten\n");
    const orphans = await reanchorFile(docs, "guide.md", hub);
    expect(orphans).toBe(0);
    const { json } = await api("GET", "/api/comments?path=guide.md");
    expect((json as Sidecar).annotations[0].status).toBe("open");
  });

  it("author reply reopens a declined comment and folds history into the thread", async () => {
    const ann = await createComment("lazy dog", "cut this idiom");
    await resolveComment(docs, hub, {
      path: "guide.md",
      id: ann.id,
      action: "declined",
      note: "The idiom is load-bearing here.",
    });
    const res = await api("PATCH", `/api/comments/${ann.id}`, {
      path: "guide.md",
      reply: "It really isn't - cut it.",
    });
    const updated = res.json as Annotation;
    expect(updated.status).toBe("open");
    expect(updated.resolution).toBeNull();
    expect(updated.replies).toHaveLength(2);
    expect(updated.replies![0]).toMatchObject({ by: "claude" });
    expect(updated.replies![1]).toMatchObject({ by: "author", text: "It really isn't - cut it." });

    const open = await listOpenComments(docs, "guide.md");
    expect(open[0].thread).toHaveLength(2);
  });

  it("search finds matches with plain-text offsets", async () => {
    const res = await api("GET", "/api/search?q=lazy%20dog");
    const results = res.json as Array<{ path: string; start: number; snippet: string }>;
    expect(results).toHaveLength(1);
    expect(results[0].path).toBe("guide.md");
    const plain = markdownToPlainText(DOC);
    expect(plain.slice(results[0].start, results[0].start + 8)).toBe("lazy dog");
  });

  it("change review: baseline init on open, external edits flag, mark-reviewed clears", async () => {
    const first = await api("GET", "/api/doc?path=guide.md");
    expect((first.json as { changed: boolean }).changed).toBe(false);

    // Claude edits externally -> changed
    await fs.writeFile(path.join(root, "guide.md"), DOC + "\nAn appended paragraph.\n");
    const after = await api("GET", "/api/doc?path=guide.md");
    expect((after.json as { changed: boolean }).changed).toBe(true);

    const baseline = await api("GET", "/api/baseline?path=guide.md");
    expect((baseline.json as { markdown: string }).markdown).toBe(DOC);

    await api("POST", "/api/reviewed", { path: "guide.md" });
    const reviewed = await api("GET", "/api/doc?path=guide.md");
    expect((reviewed.json as { changed: boolean }).changed).toBe(false);
  });

  it("browser saves advance the baseline (own edits are not 'changes')", async () => {
    const { json: doc } = await api("GET", "/api/doc?path=guide.md");
    await api("PUT", "/api/doc", {
      path: "guide.md",
      markdown: DOC + "\nMy own edit.\n",
      baseHash: (doc as { hash: string }).hash,
    });
    const after = await api("GET", "/api/doc?path=guide.md");
    expect((after.json as { changed: boolean }).changed).toBe(false);
  });
});

describe("author-close vs claude resolution", () => {
  it("author resolving from the UI records no claude attribution", async () => {
    const ann = await createComment("lazy dog", "just noting this");
    const res = await api("PATCH", `/api/comments/${ann.id}`, {
      path: "guide.md",
      status: "resolved",
    });
    const updated = res.json as Annotation;
    expect(updated.status).toBe("resolved");
    expect(updated.resolution).toBeNull();
  });

  it("folded thread entries carry the structured action", async () => {
    const ann = await createComment("lazy dog", "cut this");
    await resolveComment(docs, hub, {
      path: "guide.md",
      id: ann.id,
      action: "declined",
      note: "It stays.",
    });
    const res = await api("PATCH", `/api/comments/${ann.id}`, {
      path: "guide.md",
      reply: "no, cut it",
    });
    const updated = res.json as Annotation;
    expect(updated.replies![0]).toMatchObject({ by: "claude", action: "declined", text: "It stays." });
  });

  it("accepting an addressed proposal closes it and keeps Claude's note", async () => {
    const ann = await createComment("lazy dog", "rephrase");
    await resolveComment(docs, hub, {
      path: "guide.md",
      id: ann.id,
      action: "resolved",
      note: "Rephrased as requested.",
    });
    const res = await api("PATCH", `/api/comments/${ann.id}`, {
      path: "guide.md",
      status: "resolved",
    });
    const updated = res.json as Annotation;
    expect(updated.status).toBe("resolved");
    expect(updated.resolution).toEqual({ action: "resolved", note: "Rephrased as requested." });
  });

  it("reopening an addressed proposal folds it into the thread", async () => {
    const ann = await createComment("lazy dog", "rephrase");
    await resolveComment(docs, hub, {
      path: "guide.md",
      id: ann.id,
      action: "resolved",
      note: "Rephrased.",
    });
    const res = await api("PATCH", `/api/comments/${ann.id}`, {
      path: "guide.md",
      status: "open",
    });
    const updated = res.json as Annotation;
    expect(updated.status).toBe("open");
    expect(updated.resolution).toBeNull();
    expect(updated.replies![0]).toMatchObject({ by: "claude", action: "resolved", text: "Rephrased." });
    // reopened comments are back in Claude's queue
    const open = await listOpenComments(docs, "guide.md");
    expect(open.map((c) => c.id)).toEqual([ann.id]);
  });

  it("author edits their own reply; Claude's entries are protected", async () => {
    const ann = await createComment("lazy dog", "cut this");
    await resolveComment(docs, hub, {
      path: "guide.md",
      id: ann.id,
      action: "declined",
      note: "It stays.",
    });
    await api("PATCH", `/api/comments/${ann.id}`, { path: "guide.md", reply: "typo herre" });
    // replies[0] is Claude's folded decline, replies[1] the author's rebuttal
    const ok = await api("PATCH", `/api/comments/${ann.id}`, {
      path: "guide.md",
      editReply: { index: 1, text: "typo here" },
    });
    expect((ok.json as Annotation).replies![1].text).toBe("typo here");

    const claudes = await api("PATCH", `/api/comments/${ann.id}`, {
      path: "guide.md",
      editReply: { index: 0, text: "hax" },
    });
    expect(claudes.status).toBe(400);

    const missing = await api("PATCH", `/api/comments/${ann.id}`, {
      path: "guide.md",
      editReply: { index: 9, text: "x" },
    });
    expect(missing.status).toBe(404);
  });

  it("re-anchor passes never demote a pending proposal to orphaned", async () => {
    const ann = await createComment("quick brown fox", "modernize");
    await resolveComment(docs, hub, {
      path: "guide.md",
      id: ann.id,
      action: "resolved",
      note: "Replaced the idiom.",
    });
    // Claude's own edit removed the quoted passage
    await fs.writeFile(
      path.join(root, "guide.md"),
      DOC.replace("The quick brown fox jumps over the lazy dog.", "A drone hums past."),
    );
    const orphans = await reanchorFile(docs, "guide.md", hub);
    expect(orphans).toBe(0);
    const sidecar = (await api("GET", "/api/comments?path=guide.md")).json as Sidecar;
    expect(sidecar.annotations.find((a) => a.id === ann.id)!.status).toBe("addressed");
  });
});

describe("document import", () => {
  it("imports under a sanitized name and never overwrites", async () => {
    const r1 = await api("POST", "/api/import", { name: "My Notes.md", markdown: "# Hi\n" });
    expect(r1.status).toBe(201);
    expect((r1.json as { path: string }).path).toBe("My-Notes.md");

    const r2 = await api("POST", "/api/import", { name: "My Notes.md", markdown: "# Again\n" });
    expect((r2.json as { path: string }).path).toBe("My-Notes-1.md");

    const doc = await api("GET", "/api/doc?path=My-Notes.md");
    expect((doc.json as { markdown: string }).markdown).toBe("# Hi\n");
    // importing is the user's own act — no pending "changes" on first open
    expect((doc.json as { changed: boolean }).changed).toBe(false);
  });

  it("strips directories and traversal from the suggested name", async () => {
    const r = await api("POST", "/api/import", { name: "../../etc/passwd", markdown: "x\n" });
    expect((r.json as { path: string }).path).toBe("passwd.md");
  });
});

describe("review-pass regressions", () => {
  it("POST /api/comments certifies docHash only when baseHash matches disk", async () => {
    // no baseHash sent -> hints not certified
    await createComment("quick brown fox", "note");
    let sidecar = (await api("GET", "/api/comments?path=guide.md")).json as Sidecar;
    expect(sidecar.docHash).toBe("");

    // correct baseHash sent -> certified
    const { json: doc } = await api("GET", "/api/doc?path=guide.md");
    const plain = markdownToPlainText(DOC);
    const start = plain.indexOf("second paragraph");
    const quote = makeQuoteSelector(plain, start, start + 16);
    await api("POST", "/api/comments", {
      path: "guide.md",
      body: "another",
      baseHash: (doc as { hash: string }).hash,
      selector: {
        quote: { exact: quote.exact, prefix: quote.prefix, suffix: quote.suffix },
        position: { start, end: start + 16 },
      },
    });
    sidecar = (await api("GET", "/api/comments?path=guide.md")).json as Sidecar;
    expect(sidecar.docHash).toBe((doc as { hash: string }).hash);
  });

  it("declining an orphaned comment still proposes to the author", async () => {
    const ann = await createComment("conclusions", "expand");
    await fs.writeFile(
      path.join(root, "guide.md"),
      DOC.replace("The final paragraph is about conclusions.\n", ""),
    );
    await reanchorFile(docs, "guide.md", hub);
    await resolveComment(docs, hub, {
      path: "guide.md",
      id: ann.id,
      action: "declined",
      note: "moot now",
    });
    const sidecar = (await api("GET", "/api/comments?path=guide.md")).json as Sidecar;
    expect(sidecar.annotations.find((a) => a.id === ann.id)!.status).toBe("addressed");
  });

  it("client anchors that do not reproduce the stored quote fall back to the ladder", async () => {
    const ann = await createComment("second paragraph", "watch");
    const { json: doc } = await api("GET", "/api/doc?path=guide.md");
    // lie about where the comment is: offsets point at unrelated text
    await api("PUT", "/api/doc", {
      path: "guide.md",
      markdown: DOC,
      baseHash: (doc as { hash: string }).hash,
      anchors: [{ id: ann.id, start: 0, end: 7 }],
    });
    const sidecar = (await api("GET", "/api/comments?path=guide.md")).json as Sidecar;
    const stored = sidecar.annotations.find((a) => a.id === ann.id)!;
    // ladder re-resolved from the quote instead of trusting the bogus offsets
    expect(stored.target!.selector[0].exact).toBe("second paragraph");
    const plain = markdownToPlainText(DOC);
    expect(
      plain.slice(stored.target!.selector[1].start, stored.target!.selector[1].end),
    ).toBe("second paragraph");
  });

  it("a corrupt sidecar is quarantined instead of bricking the tree", async () => {
    await createComment("lazy dog", "keep");
    const scFile = path.join(root, ".redline", "comments", "guide.md.json");
    await fs.writeFile(scFile, "{ not json");
    const res = await api("GET", "/api/tree");
    expect(res.status).toBe(200); // no 500
    const entries = res.json as Array<{ openComments: number }>;
    expect(entries[0].openComments).toBe(0); // quarantined -> fresh sidecar
    const listing = await fs.readdir(path.dirname(scFile));
    expect(listing.some((f) => f.includes(".corrupt-"))).toBe(true);
  });

  it("plaintext emits no leading separator for no-output first blocks", () => {
    expect(markdownToPlainText("---\n\nHello")).toBe("Hello");
  });

  it("tree badge counts orphaned comments as actionable", async () => {
    await createComment("conclusions", "expand");
    await fs.writeFile(
      path.join(root, "guide.md"),
      DOC.replace("The final paragraph is about conclusions.\n", ""),
    );
    await reanchorFile(docs, "guide.md", hub);
    const { json } = await api("GET", "/api/tree");
    expect((json as Array<{ openComments: number }>)[0].openComments).toBe(1);
  });
});
