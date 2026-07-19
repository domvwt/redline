---
name: redline-comments
description: Address the user's redline review comments on markdown docs. Use when the user says "address my review comments", "handle my redline comments", or similar — or when redline MCP tools (list_comments/resolve_comment) are available and the user refers to comments they left in the review UI.
---

# Address redline review comments

The user reviews rendered markdown in the redline browser UI and leaves
comments anchored to quoted passages. Your job is an **editorial pass**, the
way a thoughtful human editor would respond to margin comments.

## Workflow

1. Fetch the open comments:
   - Preferred: call the `list_comments` MCP tool if it is available (the
     redline stdio MCP — it reads the same sidecar files as the fallback).
   - Fallback: read `.redline/comments/*.json` in the project — each file is
     the sidecar for one document (its `docPath` field names the document;
     filenames flatten `/` to `__`, and `__project__.json` holds project-wide
     notes). Open comments have `"status": "open"` or `"orphaned"`.
   - Comments with a null quote are **unanchored notes**: they apply to the
     whole document, or — under path `__project__` — to the whole project
     (typically requests for new documents or restructuring; fulfill them by
     creating or reorganizing files, then resolve).
   - A comment's `thread`/`replies` holds prior back-and-forth. A reopened
     comment with an author reply means your earlier resolution didn't
     satisfy them — engage with the reply, don't repeat yourself.
2. **Read every comment before editing anything.** Look for cross-comment
   themes (the same tone/clarity complaint in three places usually means a
   document-wide pass) and for contradictions between comments — flag
   contradictions to the user instead of guessing.
3. Address each comment in the document with your normal editing tools:
   - Quotes come from the RENDERED text: markdown markup (`**`, backticks,
     line-wrapping) may interrupt the quote in the source. Locate the passage
     by meaning, not byte-exact search.
   - Preserve the author's voice, formatting, and heading structure. Do not
     rewrite passages nobody commented on unless a theme clearly demands it.
   - If a comment is misguided, decline it with a reason rather than making
     the edit.
4. After addressing each comment, record your **proposal** — you never close
   a comment yourself; the author accepts or rejects each proposal in the UI:
   - Preferred: `resolve_comment` MCP tool with `action: "resolved"` (or
     `"declined"`) and a note the author will read — say what you changed.
   - Fallback: edit the sidecar JSON directly. In BOTH cases set
     `"status": "addressed"` plus the proposal:
     `"resolution": {"action": "resolved", "note": "<what you changed>"}` or
     `"resolution": {"action": "declined", "note": "<why not>"}`.
     Never set `"status": "resolved"` — that state is the author's alone.
5. Finish with a short summary: what you propose changed, what you declined
   and why, and any themes or contradictions worth the author's attention.
   Present the work as awaiting their review, not as done — they still
   accept or reject each proposal.

If the user has the redline daemon running, their browser updates live as
you edit and resolve — no need to tell them to refresh.
