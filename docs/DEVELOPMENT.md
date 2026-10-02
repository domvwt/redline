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
  *Unanchored* state. When the daemon saw the edit happen (it holds the exact
  prior text), the revision's block-aware diff decides first: unchanged
  passages follow their offsets, rewritten ones map onto their replacement,
  deleted ones unanchor — the ladder's exact find still wins where the
  revision put text (a move, merge or split), never in untouched text.
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
- **Agent link**: the browser's *send to agent* reaches the agent through
  two files in `.redline/`. Only the daemon writes `handoff.json`
  (`{seq, action, sendSeq, at}`: `seq` bumps on every Send/Done click,
  `sendSeq` is the latest Send's, so a Done can't swallow a queued round);
  only `redline wait` writes `agent.json` (`{state, pid, owner, consumed,
  at}`: `owner` is per-wait, so a newer wait supersedes an older one; `at`
  is a heartbeat while listening). A wait wakes when
  `sendSeq > consumed` and there's something open; a re-arm (`--resume`)
  also ends on a pending Done, while a first wait treats every earlier
  click, Send or Done, as moot. The daemon polls both files each second, so a dead or silent
  listener reads as *absent*, and pushes `agent:changed` over SSE
  (`server/src/agent-link.ts`). *working* has no liveness signal (the wait
  has exited and handed over to the agent): an agent leaving the loop runs
  `redline wait --stop`, a Done clears it at once, and otherwise it expires
  after 2 hours. A wait that ends the loop on Done writes `finished`, so the
  header can tell "review finished" from "no agent".
- **Write guard**: a Send wakes an agent that edits files, so the daemon
  refuses non-GET requests from any other origin (Origin must match the
  request's host:port exactly; with no Origin, a `Sec-Fetch-Site:
  cross-site` is refused) — plain browser form posts would otherwise reach
  it from any page.

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
