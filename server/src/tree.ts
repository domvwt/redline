import { promises as fs } from "node:fs";
import path from "node:path";
import type { TreeEntry } from "@redline/shared";
import { loadSidecar } from "./sidecar.ts";

const IGNORED_DIRS = new Set([".git", "node_modules", ".redline", "dist", "build", ".venv"]);

export async function listMarkdownFiles(root: string): Promise<TreeEntry[]> {
  const out: TreeEntry[] = [];

  const walk = async (dir: string) => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile() && /\.(md|markdown)$/i.test(entry.name)) {
        const rel = path.relative(root, abs).split(path.sep).join("/");
        const sidecar = await loadSidecar(root, rel);
        out.push({
          path: rel,
          name: entry.name,
          // everything not finally resolved still needs someone's attention:
          // open/orphaned await Claude, addressed await the author's verdict
          openComments: sidecar.annotations.filter((a) => a.status !== "resolved").length,
          agentReady: sidecar.annotations.filter(
            (a) => a.status === "open" || a.status === "orphaned",
          ).length,
        });
      }
    }
  };

  await walk(root);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}
