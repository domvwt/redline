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
- **Agent link**: the browser's *Send to agent* reaches the agent through
  two files in `.redline/`. Only the daemon writes `handoff.json`
  (`{seq, action, sendSeq, dropped?, force?, at}`: `seq` bumps on every
  Send/Done/Drop click, `sendSeq` is the latest Send's, so a Done can't
  swallow a queued round, and `dropped` is the `sendSeq` the author withdrew
  with *Drop the send* — no wait runs it, but the loop isn't ended, and a
  Drop landing on a Done no wait has seen keeps the Done);
  only `redline wait` writes `agent.json` (`{state, pid, owner, consumed,
  at, round, roundAt, rounds, session}`: `owner` is per-wait, so a newer
  wait supersedes an older one; `session` is per agent session, carried by
  its re-arms, and keys the bar's Dismiss; `at` is a heartbeat while
  listening; `round` holds the `{path, id}`s the latest send handed over, at
  `roundAt`). The daemon counts the round's progress from those sidecars
  alone: a comment is answered once it's no longer open, or once the agent
  has proposed on it since `roundAt` (a reply or reopen after that is next
  round's work). A wait wakes when
  `sendSeq > consumed` and there's something open; a re-arm (`--resume`)
  also ends on a pending Done, while a first wait treats every earlier
  click, Send or Done, as moot. A wait that times out writes `rearming`,
  which reads as listening for a minute while the agent starts the next.
  The daemon polls both files each second, so a dead or silent listener
  reads as *absent*, and pushes `agent:changed` over SSE
  (`server/src/agent-link.ts`). *working* has no liveness signal (the wait
  has exited and handed over to the agent): an agent leaving the loop runs
  `redline wait --stop`, and otherwise it expires after 2 hours. A Done
  while working reads as *stopping* (the agent finishes its pass, and any
  round queued before the Done, then its re-arm ends on the Done); a second
  Done while stopping, at least 10 s after the first (sooner is a double
  click or a second tab), sets `force` in `handoff.json` and reads as finished,
  for an agent that died mid-pass (if it was alive after all, its re-arm
  ends on that Done, skipping any queued round). A wait that ends the loop
  on Done — or a `--stop` with a Done outstanding — writes `finished`, so the bar can tell "agent stopped" from "no agent".
- **Write guard**: a Send wakes an agent that edits files, so the daemon
  refuses non-GET requests from any other origin (Origin must match the
  request's host:port exactly; with no Origin, a `Sec-Fetch-Site:
  cross-site` is refused) — plain browser form posts would otherwise reach
  it from any page.

## Working on redline

```sh
npm test                             # anchoring + API/workflow + agent bar (jsdom) tests
npm run dev                          # daemon :5175 (sample-docs) + vite :5174 (HMR)
REDLINE_ROOT=~/my/docs npm run dev   # point the dev daemon elsewhere
```

Layout:

- `shared/` — types, plain-text rendering, anchor ladder
- `server/` — daemon
- `web/` — React + Milkdown UI
- `skill/` — Claude Code skill
- `sample-docs/` — playground
