import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { atomicWrite } from "./sidecar.ts";

export class DocStore {
  /** Last content read per canonical path (LRU, capped). The watcher fires
   *  only after a file has already changed on disk, so this is the only place
   *  the pre-revision text survives — reanchorFile diffs against it (when its
   *  hash still certifies the sidecar's positions) to map comments through
   *  rewrites the quote search cannot follow. Best-effort: empty after a
   *  daemon restart, and re-anchoring then falls back to the quote ladder.
   *  Deliberately NOT updated by write(): the author-save route reads the
   *  current content for its conflict check before writing, and that read is
   *  the pre-revision text the follow-up re-anchor pass needs. */
  private lastSeenByPath = new Map<string, string>();
  private static readonly LAST_SEEN_CAP = 64;

  constructor(readonly root: string) {}

  lastSeen(relPath: string): string | undefined {
    const key = this.canonical(relPath);
    const markdown = this.lastSeenByPath.get(key);
    if (markdown !== undefined) {
      // refresh recency (Map iterates in insertion order)
      this.lastSeenByPath.delete(key);
      this.lastSeenByPath.set(key, markdown);
    }
    return markdown;
  }

  forget(relPath: string): void {
    this.lastSeenByPath.delete(this.canonical(relPath));
  }

  /** Resolve a repo-relative path, rejecting traversal outside the root. */
  resolve(relPath: string): string {
    const abs = path.resolve(this.root, relPath);
    const rootAbs = path.resolve(this.root);
    if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
      throw new PathError(`path escapes root: ${relPath}`);
    }
    return abs;
  }

  /** Resolve to the canonical root-relative path (rejecting traversal), so
   *  aliases like './a.md' or 'b/../a.md' cannot address a second sidecar
   *  file or lock key for the same document. */
  canonical(relPath: string): string {
    const abs = this.resolve(relPath);
    const rel = path.relative(path.resolve(this.root), abs).split(path.sep).join("/");
    if (!rel) throw new PathError(`not a document path: ${relPath}`);
    return rel;
  }

  /** Like resolve, but also refuses symlinks that point outside the root. */
  async resolveReal(relPath: string): Promise<string> {
    const abs = this.resolve(relPath);
    const rootReal = await fs.realpath(path.resolve(this.root));
    let real: string;
    try {
      real = await fs.realpath(abs);
    } catch {
      return abs; // doesn't exist yet — lexical check already passed
    }
    if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
      throw new PathError(`path escapes root via symlink: ${relPath}`);
    }
    return real;
  }

  async read(relPath: string): Promise<{ markdown: string; hash: string }> {
    const markdown = await fs.readFile(await this.resolveReal(relPath), "utf8");
    const key = this.canonical(relPath);
    this.lastSeenByPath.delete(key);
    this.lastSeenByPath.set(key, markdown);
    if (this.lastSeenByPath.size > DocStore.LAST_SEEN_CAP) {
      const oldest = this.lastSeenByPath.keys().next().value!;
      this.lastSeenByPath.delete(oldest);
    }
    return { markdown, hash: hashOf(markdown) };
  }

  async write(relPath: string, markdown: string): Promise<string> {
    await atomicWrite(this.resolve(relPath), markdown);
    return hashOf(markdown);
  }
}

export function hashOf(content: string): string {
  return "sha256:" + createHash("sha256").update(content, "utf8").digest("hex");
}

export class PathError extends Error {}
