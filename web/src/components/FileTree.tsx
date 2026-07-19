import { useEffect, useMemo, useRef, useState } from "react";
import type { TreeEntry } from "@redline/shared";
import { api, STATIC_MODE, type SearchResult } from "../api.ts";

interface DirNode {
  name: string;
  path: string;
  dirs: DirNode[];
  files: TreeEntry[];
}

function buildTree(entries: TreeEntry[]): DirNode {
  const root: DirNode = { name: "", path: "", dirs: [], files: [] };
  for (const entry of entries) {
    const parts = entry.path.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let child = node.dirs.find((d) => d.name === part);
      if (!child) {
        child = { name: part, path: node.path ? `${node.path}/${part}` : part, dirs: [], files: [] };
        node.dirs.push(child);
      }
      node = child;
    }
    node.files.push(entry);
  }
  return root;
}

interface Props {
  entries: TreeEntry[];
  currentPath: string | null;
  onOpen(path: string): void;
  onOpenResult(result: SearchResult): void;
  /** present only where removing a document makes sense (the browser store —
   *  the daemon tree mirrors the folder on disk) */
  onRemove?(path: string): void;
  /** project-wide review state and loop actions, shown above the tree */
  reviewBlock?: React.ReactNode;
}

export function FileTree({ entries, currentPath, onOpen, onOpenResult, onRemove, reviewBlock }: Props) {
  const tree = useMemo(() => buildTree(entries), [entries]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // two-step inline confirm for removal: first click arms, second removes,
  // leaving the row disarms — no browser alert
  const [confirmingRemove, setConfirmingRemove] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const searchSeq = useRef(0);
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const q = query.trim();
    if (q.length < 2) {
      setResults(null);
      return;
    }
    searchTimer.current = setTimeout(() => {
      const seq = ++searchSeq.current;
      void api
        .search(q)
        .then((r) => {
          if (seq === searchSeq.current) setResults(r); // drop stale responses
        })
        .catch(() => {
          if (seq === searchSeq.current) setResults([]);
        });
    }, 200);
  }, [query]);

  const toggle = (dirPath: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) next.delete(dirPath);
      else next.add(dirPath);
      return next;
    });

  const renderDir = (node: DirNode, depth: number): React.ReactNode => (
    <>
      {node.dirs.map((dir) => {
        const isCollapsed = collapsed.has(dir.path);
        return (
          <li key={dir.path}>
            <button
              className={`rl-tree-folder${isCollapsed ? " collapsed" : ""}`}
              style={{ paddingLeft: 10 + depth * 14 }}
              onClick={() => toggle(dir.path)}
            >
              <span className="rl-chevron" aria-hidden>
                ▸
              </span>
              {dir.name}
            </button>
            {!isCollapsed && <ul>{renderDir(dir, depth + 1)}</ul>}
          </li>
        );
      })}
      {node.files.map((entry) => (
        <li
          key={entry.path}
          className={onRemove ? "rl-tree-li removable" : "rl-tree-li"}
          onMouseLeave={() => setConfirmingRemove(null)}
        >
          <button
            className={entry.path === currentPath ? "rl-tree-item active" : "rl-tree-item"}
            style={{ paddingLeft: 10 + depth * 14 }}
            onClick={() => onOpen(entry.path)}
            title={entry.path}
          >
            <span className="rl-tree-name">{entry.name}</span>
            {entry.openComments > 0 && <span className="rl-badge">{entry.openComments}</span>}
          </button>
          {onRemove &&
            (confirmingRemove === entry.path ? (
              <button
                className="rl-tree-remove rl-tree-remove-confirm"
                title="Click to remove — this also deletes its comments"
                onClick={() => {
                  setConfirmingRemove(null);
                  onRemove(entry.path);
                }}
              >
                remove?
              </button>
            ) : (
              <button
                className="rl-tree-remove"
                title={`Remove ${entry.name} and its comments from this browser`}
                onClick={() => setConfirmingRemove(entry.path)}
              >
                ✕
              </button>
            ))}
        </li>
      ))}
    </>
  );

  return (
    <nav className="rl-tree">
      <h1 className="rl-logo">redline</h1>
      <input
        className="rl-search"
        type="search"
        placeholder="search docs…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && setQuery("")}
      />
      {reviewBlock}
      {results !== null ? (
        <ul className="rl-results">
          {results.length === 0 && <p className="rl-muted rl-empty">No matches.</p>}
          {results.map((r, i) => (
            <li key={i}>
              <button className="rl-result" onClick={() => onOpenResult(r)}>
                <span className="rl-result-path">{r.path}</span>
                <span className="rl-result-snippet">{r.snippet}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <>
          {entries.length === 0 && (
            <p className="rl-muted rl-empty">
              {STATIC_MODE
                ? "No documents yet — drop a markdown file anywhere in this window, or paste one from your clipboard."
                : "No markdown files found in this folder."}
            </p>
          )}
          <ul>{renderDir(tree, 0)}</ul>
        </>
      )}
    </nav>
  );
}
