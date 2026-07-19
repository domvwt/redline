# Development

Technical reference for redline. If you just want to review documents, the
[README](../README.md) has everything you need.

## Architecture

```
┌──────────────┐        REST + SSE        ┌──────────────────┐
│  browser UI  │ ◀──────────────────────▶ │  redline daemon  │
│  (review)    │   live doc + comments    │  (localhost)     │
└──────────────┘                          └────────┬─────────┘
                                          watches  │  docs + sidecars
                                                   ▼
                              ┌─────────────────────────────────────┐
                              │  your files: *.md + .redline/*.json │
                              └─────────────────────────────────────┘
                                                   ▲
                                edits + resolves   │  (stdio MCP or plain read/edit)
                                            your AI agent
```

The filesystem is the bus: the agent works on the files, the daemon's watcher
sees the writes and pushes them to the browser. The agent never talks to the
daemon. Comments are plain JSON sidecars and `redline mcp` speaks standard
MCP, so any agent that can read and write files runs the loop; chat-only
assistants fit via the sidebar's copy-for-chat export.

## How it works

- **Sidecars**: one JSON file per document in `.redline/comments/`
  (auto-added to your `.gitignore`), using W3C Web Annotation-style
  selectors — the quoted text + ~32 chars of context is the primary anchor;
  character offsets are only a cache hint.
- **Anchor ladder**: position hint → exact quote match (context-disambiguated
  when the quote appears more than once) → fuzzy match (Hypothesis's
  `approx-string-match`, error budget ~20% of quote length) → visible
  *Unanchored* state.
- **Quotes are from rendered text**: `**bold** word` anchors as `bold word`,
  so comments span formatting naturally. The agent is told this so it locates
  passages by meaning, not byte-exact search.
- **Markdown dialect**: the editor renders CommonMark + GFM (Milkdown's
  `commonmark` and `gfm` presets — the same pair GitHub uses). Content
  outside that — YAML frontmatter, MDX, definition lists — displays as
  literal text rather than disappearing. The plain-text anchor domain is
  computed with remark from the same grammar.
- **Daemon**: Hono on localhost — doc/comment REST API, SSE push, chokidar
  watcher. Serves the browser only; the agent never connects to it.
- **MCP**: `redline mcp [dir]` is a stdio server spawned on demand by the
  agent's MCP client. It reads and writes the same sidecar files as the
  daemon, which notices via its watcher — the two never talk directly.

## Working on redline

```sh
npm test                             # anchoring + API/workflow tests
npm run dev                          # daemon :5175 (sample-docs) + vite :5174 (HMR)
REDLINE_ROOT=~/my/docs npm run dev   # point the dev daemon elsewhere
```

Layout:

- `shared/` — types, plain-text rendering, anchor ladder
- `server/` — daemon
- `web/` — React + Milkdown UI
- `skill/` — Claude Code skill
- `sample-docs/` — playground
