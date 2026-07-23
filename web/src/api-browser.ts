import {
  applyAuthorPatch,
  authorReply,
  certifyPositionHints,
  emptySidecar,
  markdownToPlainText,
  newAnnotation,
  PatchError,
  PROJECT_PATH,
  proposeResolution,
  reanchorAnnotation,
  reanchorAnnotations,
  snapshotPriorQuotes,
} from "@redline/shared";
import type { Annotation, ServerEvent, Sidecar, TreeEntry } from "@redline/shared";
import { ApiError, type RedlineApi, type SubscribeEvents } from "./api-types.ts";

/**
 * Serverless backend for the static web build: documents, baselines, and
 * comment sidecars live in IndexedDB; "the agent" is any AI chat the user
 * copies a handoff prompt into. Same lifecycle semantics as the daemon —
 * both call the shared comments-core.
 */

const DB_NAME = "redline-web";
const DOCS = "docs";
const BASELINES = "baselines";
const SIDECARS = "sidecars";

let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(DOCS);
      req.result.createObjectStore(BASELINES);
      req.result.createObjectStore(SIDECARS);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet<T>(store: string, key: string): Promise<T | undefined> {
  const d = await db();
  return request(d.transaction(store).objectStore(store).get(key) as IDBRequest<T | undefined>);
}

async function idbPut(store: string, key: string, value: unknown): Promise<void> {
  const d = await db();
  await request(d.transaction(store, "readwrite").objectStore(store).put(value, key));
}

async function idbDelete(store: string, key: string): Promise<void> {
  const d = await db();
  await request(d.transaction(store, "readwrite").objectStore(store).delete(key));
}

async function idbKeys(store: string): Promise<string[]> {
  const d = await db();
  const keys = await request(d.transaction(store).objectStore(store).getAllKeys());
  return keys as string[];
}

async function hashOf(markdown: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(markdown));
  return (
    "sha256:" +
    Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")
  );
}

/** Per-path mutation chain: async interleavings (event-triggered refresh vs
 *  user action) must not clobber a sidecar read-modify-write. */
const locks = new Map<string, Promise<unknown>>();

function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(
    key,
    next.catch(() => {}),
  );
  return next;
}

// ---- events: local listeners + cross-tab broadcast --------------------------

const listeners = new Set<(e: ServerEvent) => void>();
const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("redline-web") : null;
if (channel) {
  channel.onmessage = (msg) => {
    for (const l of listeners) l(msg.data as ServerEvent);
  };
}

function emit(event: ServerEvent): void {
  for (const l of listeners) l(event);
  channel?.postMessage(event);
}

export const subscribeEvents: SubscribeEvents = (handlers) => {
  listeners.add(handlers.onEvent);
  return () => listeners.delete(handlers.onEvent);
};

// ---- seed -------------------------------------------------------------------

const WELCOME_PATH = "welcome.md";
const WELCOME = `# Welcome to redline

This is the **web version** — your documents and comments stay in your
browser, on this device. Nothing is uploaded anywhere.

## The loop

1. **Bring a document in**: drag a \`.md\` file onto the window, or copy
   markdown and paste it anywhere outside a text box.
2. **Review it**: highlight any passage and just type — your note attaches to
   the exact phrase. Add document-wide thoughts with *+ document note*.
3. **Hand off to your AI**: press *copy for AI* and paste the result into any
   assistant — ChatGPT, Copilot, Gemini, Claude. It contains the document,
   your comments, and instructions for replying.
4. **Paste the reply back**: the assistant answers each comment and returns a
   revised document. Press *paste reply*, and redline applies the new
   version, attaches each response to its comment, and marks them *awaiting
   your review* — you accept or send back with a reply, comment by comment.

Comments survive edits: quotes re-anchor when the text moves, and a passage
that disappears entirely turns into an unanchored comment rather than being
silently dropped.

Try it now — highlight this sentence and type something.
`;

let seeded = false;

async function ensureSeed(): Promise<void> {
  if (seeded) return;
  seeded = true;
  // the flag (not doc count) decides: deleting every document — the welcome
  // doc included — must not resurrect it on the next visit
  if (localStorage.getItem("redline-seeded") === "1") return;
  localStorage.setItem("redline-seeded", "1");
  const keys = await idbKeys(DOCS);
  if (keys.length > 0) return;
  await idbPut(DOCS, WELCOME_PATH, WELCOME);
  await idbPut(BASELINES, WELCOME_PATH, WELCOME);
}

// ---- api --------------------------------------------------------------------

async function readDoc(path: string): Promise<string> {
  const markdown = await idbGet<string>(DOCS, path);
  if (markdown === undefined) throw new ApiError("not found", 404);
  return markdown;
}

async function loadSidecar(path: string): Promise<Sidecar> {
  return (await idbGet<Sidecar>(SIDECARS, path)) ?? emptySidecar(path);
}

async function saveSidecar(path: string, sidecar: Sidecar): Promise<void> {
  sidecar.docPath = path;
  await idbPut(SIDECARS, path, sidecar);
}

/** Mirror of the daemon's reanchorFile: skip when the sidecar is already
 *  certified at the current content. A caller that has the pre-revision
 *  markdown passes it as `priorMarkdown`; when its hash still certifies the
 *  sidecar's positions, diff-based span mapping survives rewrites the quote
 *  ladder cannot find. */
async function reanchorDoc(
  path: string,
  anchors?: Array<{ id: string; start: number; end: number }>,
  priorMarkdown?: string,
): Promise<void> {
  await withLock(path, async () => {
    const sidecar = await loadSidecar(path);
    if (sidecar.annotations.length === 0) return;
    const markdown = await readDoc(path);
    const hash = await hashOf(markdown);
    if (sidecar.docHash === hash && !anchors) return;
    const priorPlain =
      priorMarkdown !== undefined && (await hashOf(priorMarkdown)) === sidecar.docHash
        ? markdownToPlainText(priorMarkdown)
        : null;
    reanchorAnnotations(sidecar, markdownToPlainText(markdown), hash, anchors, priorPlain);
    await saveSidecar(path, sidecar);
    emit({ type: "comments:changed", path });
  });
}

export const api: RedlineApi = {
  tree: async () => {
    await ensureSeed();
    const out: TreeEntry[] = [];
    for (const path of await idbKeys(DOCS)) {
      const sidecar = await loadSidecar(path);
      out.push({
        path,
        name: path.split("/").pop() ?? path,
        openComments: sidecar.annotations.filter((a) => a.status !== "resolved").length,
        agentReady: sidecar.annotations.filter(
          (a) => a.status === "open" || a.status === "orphaned",
        ).length,
      });
    }
    out.sort((a, b) => a.path.localeCompare(b.path));
    return out;
  },

  getDoc: async (path) => {
    await ensureSeed();
    const markdown = await readDoc(path);
    let baseline = await idbGet<string>(BASELINES, path);
    if (baseline === undefined) {
      await idbPut(BASELINES, path, markdown);
      baseline = markdown;
    }
    return { markdown, hash: await hashOf(markdown), changed: baseline !== markdown };
  },

  getBaseline: async (path) => ({ markdown: (await idbGet<string>(BASELINES, path)) ?? null }),

  markReviewed: async (path) => {
    await idbPut(BASELINES, path, await readDoc(path));
    return { ok: true };
  },

  search: async (q) => {
    q = q.trim();
    if (q.length < 2) return [];
    // case-insensitive regex on the ORIGINAL text — lowercasing the haystack
    // is not length-preserving, which would skew reported offsets
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    const results: Array<{ path: string; start: number; end: number; snippet: string }> = [];
    for (const path of await idbKeys(DOCS)) {
      const plain = markdownToPlainText(await readDoc(path));
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(plain)) !== null && results.length < 50) {
        const from = Math.max(0, m.index - 40);
        const to = Math.min(plain.length, m.index + m[0].length + 40);
        results.push({
          path,
          start: m.index,
          end: m.index + m[0].length,
          snippet: (from > 0 ? "…" : "") + plain.slice(from, to) + (to < plain.length ? "…" : ""),
        });
        if (m.index === re.lastIndex) re.lastIndex++;
      }
      if (results.length >= 50) break;
    }
    return results;
  },

  putDoc: async ({ path, markdown, baseHash, anchors }) => {
    const current = await readDoc(path);
    if ((await hashOf(current)) !== baseHash) {
      throw new ApiError("document changed; reload before saving", 409);
    }
    await idbPut(DOCS, path, markdown);
    // your own edits are not "changes to review" — advance the baseline
    await idbPut(BASELINES, path, markdown);
    await reanchorDoc(path, anchors, current);
    return { hash: await hashOf(markdown) };
  },

  importDoc: async ({ name, markdown }) => {
    const base = name
      .split("/")
      .pop()!
      .replace(/\.(md|markdown|txt)$/i, "")
      .replace(/[^\p{L}\p{N}._ -]/gu, "")
      .trim()
      .replace(/\s+/g, "-");
    const slug = base || "imported";
    const existing = new Set(await idbKeys(DOCS));
    let rel = `${slug}.md`;
    for (let i = 1; existing.has(rel); i++) rel = `${slug}-${i}.md`;
    await idbPut(DOCS, rel, markdown);
    // importing is the user's own act — the doc starts with no "changes"
    await idbPut(BASELINES, rel, markdown);
    emit({ type: "doc:changed", path: rel, hash: await hashOf(markdown), source: "external" });
    return { path: rel };
  },

  getComments: async (path) => loadSidecar(path),

  createComment: async (body) => {
    if (body.path === PROJECT_PATH && body.selector) {
      throw new ApiError("project notes cannot be anchored", 400);
    }
    if (body.path !== PROJECT_PATH && body.selector) {
      // siblings may carry stale position hints; re-anchor them so the
      // docHash certification below cannot vouch for unchecked offsets
      await reanchorDoc(body.path);
    }
    return withLock(body.path, async () => {
      const sidecar = await loadSidecar(body.path);
      const annotation = newAnnotation(
        crypto.randomUUID().slice(0, 12),
        body.body,
        body.selector ?? null,
      );
      sidecar.annotations.push(annotation);
      if (body.path !== PROJECT_PATH && body.selector) {
        certifyPositionHints(sidecar, await hashOf(await readDoc(body.path)), body.baseHash);
      }
      await saveSidecar(body.path, sidecar);
      emit({ type: "comments:changed", path: body.path });
      return annotation;
    });
  },

  patchComment: async (id, body) =>
    withLock(body.path, async () => {
      const sidecar = await loadSidecar(body.path);
      const annotation = sidecar.annotations.find((a) => a.id === id);
      if (!annotation) throw new ApiError("comment not found", 404);
      let needsReanchor: boolean;
      if (body.reply) {
        needsReanchor = authorReply(annotation, body.reply).wasClosed;
      } else {
        try {
          needsReanchor = applyAuthorPatch(annotation, body).reanchor;
        } catch (err) {
          if (err instanceof PatchError) {
            throw new ApiError(err.message, err.message === "reply not found" ? 404 : 400);
          }
          throw err;
        }
      }
      if (needsReanchor && annotation.target && body.path !== PROJECT_PATH) {
        reanchorAnnotation(markdownToPlainText(await readDoc(body.path)), annotation);
      }
      await saveSidecar(body.path, sidecar);
      emit({ type: "comments:changed", path: body.path });
      return annotation;
    }),

  deleteDoc: async (path) => {
    await readDoc(path); // 404 for a doc that was never there
    await idbDelete(DOCS, path);
    await idbDelete(BASELINES, path);
    await idbDelete(SIDECARS, path);
    emit({ type: "comments:changed", path });
    return { ok: true };
  },

  deleteComment: async (id, path) =>
    withLock(path, async () => {
      const sidecar = await loadSidecar(path);
      const before = sidecar.annotations.length;
      sidecar.annotations = sidecar.annotations.filter((a) => a.id !== id);
      if (sidecar.annotations.length === before) throw new ApiError("comment not found", 404);
      await saveSidecar(path, sidecar);
      emit({ type: "comments:changed", path });
      return { ok: true };
    }),
};

// ---- browser-only extras (handoff apply) ------------------------------------

/** Record an assistant proposal parsed from a pasted reply. Mirrors the
 *  daemon-side resolve_comment: lands in "addressed", never "resolved". */
export async function proposeFromReply(
  path: string,
  id: string,
  action: "resolved" | "declined",
  note: string,
): Promise<Annotation | null> {
  return withLock(path, async () => {
    const sidecar = await loadSidecar(path);
    const annotation = sidecar.annotations.find((a) => a.id === id);
    // a comment the author closed while the reply sat in the clipboard keeps
    // their verdict — skip rather than demote
    if (!annotation || annotation.status === "resolved") return null;
    proposeResolution(annotation, action, note);
    await saveSidecar(path, sidecar);
    emit({ type: "comments:changed", path });
    return annotation;
  });
}

/** Write a document as the external "agent" would: content changes land as
 *  reviewable changes (baseline is NOT advanced) and comments re-anchor. */
export async function writeDocAsAgent(path: string, markdown: string): Promise<void> {
  // re-anchoring will rewrite each open comment's quote to the revised text
  // (or orphan it) — snapshot the pre-revision passage first so the author
  // can compare old vs new when reviewing the proposal
  await withLock(path, async () => {
    const sidecar = await loadSidecar(path);
    if (snapshotPriorQuotes(sidecar)) await saveSidecar(path, sidecar);
  });
  // the pre-revision text drives diff-based re-anchoring — capture it before
  // the write replaces it (absent when the agent is creating the doc)
  const prior = await readDoc(path).catch(() => undefined);
  await idbPut(DOCS, path, markdown);
  const hash = await hashOf(markdown);
  emit({ type: "doc:changed", path, hash, source: "external" });
  await reanchorDoc(path, undefined, prior);
}
