# redline

Margin comments for markdown, built for the Claude Code workflow.

You read the rendered document in the browser, highlight passages, and leave
comments — the way a human reviewer marks up a draft. Your **interactive
Claude Code session** — with all its conversation context — picks the comments
up, edits the files, and resolves them. The browser updates live as Claude
works.

The conversation stays in the terminal. The browser is just the review surface.

```
┌──────────────┐   comments (sidecar JSON)   ┌──────────────────┐
│  browser UI  │ ──────────────────────────▶ │  redline daemon  │◀── MCP ── Claude Code
│  (review)    │ ◀────────────────────────── │  (localhost)     │◀── file watcher (edits)
└──────────────┘   SSE: live doc + comments  └──────────────────┘
```

## Setup

One-time, from a clone of this repo:

```sh
npm install
npm run build     # builds the web UI
npm link          # puts a `redline` command on your PATH (Node's pipx-install)
```

### Start the daemon

From your docs directory — a repo root, a `docs/` folder, anywhere with
markdown:

```sh
redline                 # serves the current directory
# → review UI:  http://127.0.0.1:5175
# → mcp:        claude mcp add --transport http redline http://127.0.0.1:5175/mcp

redline ~/other/docs    # or point it somewhere else
```

`--port <n>` changes the port. The daemon binds to localhost only. You can
also just ask Claude to launch it for you as a background task mid-session.

### Connect Claude Code (one-time)

```sh
claude mcp add --transport http redline http://127.0.0.1:5175/mcp
```

This gives Claude two tools: `list_comments` and `resolve_comment`. Use
`--scope user` if you want it available in every project.

The registered URL pins the port: redline always uses 5175 (or your
`--port`), and if that port is taken it exits with a clear error rather than
silently moving somewhere the MCP registration can't find.

**No MCP?** It's optional. Comments live in plain JSON at
`.redline/comments/<doc>.json` inside your docs directory — Claude can read
and edit those directly. The optional skill in `skill/SKILL.md` teaches the
workflow either way; copy it to `~/.claude/skills/address-comments/SKILL.md`
if you want a `/address-comments` command.

## Using it

### Reviewing (the default mode)

1. Open <http://127.0.0.1:5175> and pick a document from the left sidebar.
2. **Highlight any passage and just type.** The comment box opens focused the
   moment your selection settles — no button to click. The document is
   read-only in Review mode, so keystrokes go to your comment.
3. **Enter** sends the comment · **Shift+Enter** for a newline · **Esc**
   cancels. The passage stays highlighted in amber.
4. Repeat across as many passages and documents as you like. Open-comment
   counts show as badges in the file tree.

While you have typed text in an open comment box, new selections are ignored
so you can't lose a half-written comment — send it or press Esc first.

Beyond passage comments:

* **Document & project notes** — the `+ document note` / `+ project note`
  buttons at the top of the sidebar create unanchored comments: thoughts about a document as
  a whole, or about the project ("add a deployment guide covering X"). Claude
  fulfills project notes by creating or restructuring documents.

* **Replies** — when Claude resolves or declines a comment, `reply` on its
  card reopens it with your rebuttal attached; Claude sees the full thread on
  the next pass.

* **Changes** — after Claude edits a document, a `● changes` button appears in
  the header: a diff of everything since you last looked (your own edits don't
  count). `mark reviewed` acknowledges it.

* **Search** — the box above the file tree searches all documents; clicking a
  result jumps to and flashes the match.

### Handing off to Claude

In your Claude Code session, in the same directory:

> address my review comments

Claude lists the comments (each one carries your note plus the exact quoted
passage and surrounding context), reads the documents, makes the edits, and
resolves each comment with a note. Because it's your interactive session, it
has the full context of whatever you've been working on together.

Watch the browser while it works: prose changes appear live, resolved
comments dim and drop to the bottom of their section with Claude's note, and
declined ones stay open with the reason.

### Comment lifecycle

| Status         | Meaning                                                                                                                                                                                                        |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Open**       | Waiting to be addressed.                                                                                                                                                                                       |
| **Resolved**   | Addressed — the resolution note says what changed. Claude may instead *decline* with a reason; declined comments stay open with the note attached so you can rebut or delete.                                  |
| **Unanchored** | The passage a comment pointed at was rewritten or deleted before the comment was addressed. Never silently dropped — the original quote is preserved in the sidebar. Delete it, or re-comment on the new text. |

The sidebar is organised by scope — **Project**, **Document**, **Inline** —
with status on the cards: unresolved items first, resolved dimmed below,
unanchored marked. Clicking a comment card scrolls to and flashes its
highlight; clicking a highlight focuses its card. You can also resolve, reopen, or delete comments
manually from the sidebar.

### Edit mode

The **Review / Edit** toggle in the header switches the document to a live
Milkdown editor for quick manual touch-ups. Edits auto-save (with your
comment anchors tracked through every keystroke) — no comment affordances in
this mode; switch back to Review to comment.

Note: opening a file never rewrites it, but your **first edit** normalizes
the markdown through Milkdown's serializer (list markers, emphasis style,
wrapping may change). Work in a git repo so that first diff is deliberate.

### While Claude (or anything else) edits

A file watcher picks up every external change — Claude's edits, `git
checkout`, another editor — re-anchors your comments against the new text,
and pushes both the document and comment positions to the browser. Anchoring
is quote-based with fuzzy matching, so comments survive edits around and even
*inside* their passage; only a genuinely deleted passage unanchors.

## How it works

* **Sidecars**: one JSON file per document in `.redline/comments/`
  (auto-added to your `.gitignore`), using W3C Web Annotation-style
  selectors — the quoted text + \~32 chars of context is the primary anchor;
  character offsets are only a cache hint.

* **Anchor ladder**: position hint → exact quote match (context-disambiguated
  when the quote appears more than once) → fuzzy match (Hypothesis's
  `approx-string-match`, error budget \~20% of quote length) → visible
  *Unanchored* state.

* **Quotes are from rendered text**: `**bold** word` anchors as `bold word`,
  so comments span formatting naturally. Claude is told this so it locates
  passages by meaning, not byte-exact search.

* **Daemon**: Hono on localhost — doc/comment REST API, SSE push, chokidar
  watcher, and a stateless streamable-HTTP MCP endpoint at `/mcp`.

## Development

```sh
npm test                             # anchoring + API/workflow tests
npm run dev                          # daemon :5175 (sample-docs) + vite :5174 (HMR)
REDLINE_ROOT=~/my/docs npm run dev   # point the dev daemon elsewhere
```

Layout: `shared/` (types, plain-text rendering, anchor ladder) ·
`server/` (daemon) · `web/` (React + Milkdown UI) · `skill/` (Claude Code
skill) · `sample-docs/` (playground).

## Troubleshooting

* **Comments not appearing for Claude** — is the daemon running in the right
  directory, and the MCP URL's port correct? `curl http://127.0.0.1:5175/api/tree`
  should list your files. Without MCP, ask Claude to read
  `.redline/comments/*.json`.

* **Browser not updating live** — the SSE connection drops if the daemon
  restarts; refresh the page.

* **A comment unanchored unexpectedly** — the passage was probably rewritten
  wholesale (rewrites beyond \~20% of the quote defeat fuzzy matching, by
  design). The quote is preserved on the card; re-comment on the new text.

* **409 "document changed on disk"** — you edited in the browser while the
  file changed underneath (rare; external edits normally reload live).
  Refresh; external edits win.
