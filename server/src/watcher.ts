import chokidar, { FSWatcher } from "chokidar";
import { promises as fs } from "node:fs";
import path from "node:path";
import { reanchorFile } from "./anchoring.ts";
import { DocStore, hashOf } from "./docs.ts";
import { EventHub } from "./events.ts";
import { isOwnWrite } from "./own-writes.ts";

const DEBOUNCE_MS = 250;

/**
 * Watches the docs root for external edits (Claude in the terminal, git, other
 * editors). On a markdown change: re-anchor comments and push the new doc to
 * the browser. On a sidecar change (e.g. Claude resolving a comment): push
 * comments to the browser.
 */
export function startWatcher(docs: DocStore, hub: EventHub): FSWatcher {
  const pending = new Map<string, NodeJS.Timeout>();

  const watcher = chokidar.watch(docs.root, {
    ignored: (p, stats) => {
      const rel = path.relative(docs.root, p);
      if (rel.split(path.sep).some((seg) => seg === ".git" || seg === "node_modules")) return true;
      // watch .redline/comments but nothing else under .redline
      if (rel === ".redline" || rel.startsWith(".redline" + path.sep)) {
        return !(
          rel === ".redline" ||
          rel === path.join(".redline", "comments") ||
          rel.startsWith(path.join(".redline", "comments") + path.sep)
        );
      }
      if (stats?.isFile()) return !/\.(md|markdown|json)$/i.test(p);
      return false;
    },
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  });

  const schedule = (absPath: string, run: (absPath: string) => Promise<void>) => {
    const existing = pending.get(absPath);
    if (existing) clearTimeout(existing);
    pending.set(
      absPath,
      setTimeout(() => {
        pending.delete(absPath);
        void run(absPath);
      }, DEBOUNCE_MS),
    );
  };

  const handleChange = (absPath: string) => {
    if (isOwnWrite(absPath)) return;
    schedule(absPath, processChange);
  };

  const handleUnlink = (absPath: string) => {
    schedule(absPath, async (p) => {
      const rel = path.relative(docs.root, p).split(path.sep).join("/");
      if (/\.(md|markdown)$/i.test(rel)) {
        docs.forget(rel);
        // tree refresh; if the doc is open, the client's refetch will 404 and surface it
        hub.broadcast({ type: "doc:changed", path: rel, hash: "", source: "external" });
      } else if (rel.startsWith(".redline/comments/") && rel.endsWith(".json")) {
        // sidecar deleted externally (rm, git clean) — the file is gone, so
        // sidecarDocPath falls back to the filename decode
        const docRel = await sidecarDocPath(p);
        if (docRel) hub.broadcast({ type: "comments:changed", path: docRel });
      }
    });
  };

  const processChange = async (absPath: string) => {
    const rel = path.relative(docs.root, absPath).split(path.sep).join("/");
    try {
      if (rel.startsWith(".redline/comments/") && rel.endsWith(".json")) {
        // sidecar filenames flatten path separators irreversibly — the
        // authoritative doc path is the docPath field inside the file
        const docRel = await sidecarDocPath(absPath);
        if (docRel) hub.broadcast({ type: "comments:changed", path: docRel });
        return;
      }
      if (/\.(md|markdown)$/i.test(rel)) {
        // the watcher only sees non-own writes — this is an agent/external
        // revision, so keep the pre-revision passages for old-vs-new review
        await reanchorFile(docs, rel, hub, undefined, { snapshotPrior: true });
        const { markdown } = await docs.read(rel);
        hub.broadcast({ type: "doc:changed", path: rel, hash: hashOf(markdown), source: "external" });
      }
    } catch {
      // file may have been deleted mid-flight; ignore
    }
  };

  watcher.on("change", handleChange);
  watcher.on("add", handleChange);
  watcher.on("unlink", handleUnlink);
  return watcher;
}

async function sidecarDocPath(absSidecarPath: string): Promise<string | null> {
  try {
    const raw = JSON.parse(await fs.readFile(absSidecarPath, "utf8")) as { docPath?: string };
    if (typeof raw.docPath === "string" && raw.docPath) return raw.docPath;
  } catch {
    // fall through to legacy filename decode
  }
  // legacy sidecars (no docPath): best-effort decode; ambiguous for names
  // containing "__", exact for the common case
  const base = path.basename(absSidecarPath).replace(/\.json$/, "");
  return base === "__project__" ? "__project__" : base.replace(/__/g, "/");
}
