import { promises as fs } from "node:fs";
import path from "node:path";
import { atomicWrite } from "./sidecar.ts";

/**
 * Per-doc "last reviewed" baselines for the Changes view. The baseline is the
 * content as of the author's last look: initialized on first open, advanced on
 * every browser save (your own edits aren't "changes to review") and on an
 * explicit mark-reviewed. External edits (Claude, git) accumulate against it.
 */
function baselinePath(root: string, relPath: string): string {
  return path.join(root, ".redline", "reviewed", relPath.replace(/[\\/]/g, "__"));
}

export async function loadBaseline(root: string, relPath: string): Promise<string | null> {
  try {
    return await fs.readFile(baselinePath(root, relPath), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function saveBaseline(root: string, relPath: string, content: string): Promise<void> {
  const file = baselinePath(root, relPath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await atomicWrite(file, content);
}
