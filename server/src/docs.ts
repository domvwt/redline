import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { atomicWrite } from "./sidecar.ts";

export class DocStore {
  constructor(readonly root: string) {}

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
