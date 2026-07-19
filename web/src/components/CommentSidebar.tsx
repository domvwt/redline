import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Annotation, Reply } from "@redline/shared";

export interface CommentActions {
  onFocus(id: string): void;
  onDelete(id: string, isProject: boolean): void;
  onReopen(id: string, isProject: boolean): void;
  onMarkResolved(id: string, isProject: boolean): void;
  onReply(id: string, isProject: boolean, text: string): void;
  onEdit(id: string, isProject: boolean, text: string): void;
  onEditReply(id: string, isProject: boolean, index: number, text: string): void;
}

interface Props extends CommentActions {
  annotations: Annotation[];
  projectAnnotations: Annotation[];
  docPath: string | null;
  hasOpenDoc: boolean;
  focusedId: string | null;
  onAddNote(scope: "document" | "project", text: string): void;
}

/* ---- clipboard export: the review as self-contained markdown, so comments
   can be pasted into a chat (or anywhere else) ---- */

const isActionable = (a: Annotation) => a.status === "open" || a.status === "orphaned";

function exportMarkdown(
  docPath: string | null,
  annotations: Annotation[],
  projectAnnotations: Annotation[],
): string {
  const card = (a: Annotation): string => {
    const lines: string[] = [];
    const quote = a.target?.selector?.[0]?.exact;
    if (quote) lines.push("> " + quote.replace(/\n/g, "\n> "));
    if (a.status === "orphaned")
      lines.push("_(the quoted passage no longer exists in the document)_");
    lines.push(a.body.value);
    for (const r of a.replies ?? []) {
      lines.push(`- ${r.by}${r.action ? ` (${r.action})` : ""}: ${r.text}`);
    }
    return lines.join("\n");
  };
  const sections: string[] = [];
  const proj = projectAnnotations.filter(isActionable);
  if (proj.length) sections.push("## Project\n\n" + proj.map(card).join("\n\n"));
  const doc = annotations.filter(isActionable);
  if (doc.length) sections.push(`## ${docPath ?? "Document"}\n\n` + doc.map(card).join("\n\n"));
  return "# Review comments\n\n" + sections.join("\n\n") + "\n";
}

/* ---- minimal inline markdown (code / bold / italic) for notes & replies ---- */

type Tok = { kind: "text" | "code" | "strong" | "em"; v: string };

function tokenize(text: string): Tok[] {
  const out: Tok[] = [];
  let rest = text;
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*/;
  while (rest) {
    const m = rest.match(re);
    if (!m || m.index === undefined) {
      out.push({ kind: "text", v: rest });
      break;
    }
    if (m.index > 0) out.push({ kind: "text", v: rest.slice(0, m.index) });
    if (m[1] !== undefined) out.push({ kind: "code", v: m[1] });
    else if (m[2] !== undefined) out.push({ kind: "strong", v: m[2] });
    else out.push({ kind: "em", v: m[3] });
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

export function RichText({ text }: { text: string }) {
  return (
    <>
      {tokenize(text).map((t, i) =>
        t.kind === "code" ? (
          <code key={i}>{t.v}</code>
        ) : t.kind === "strong" ? (
          <strong key={i}>{t.v}</strong>
        ) : t.kind === "em" ? (
          <em key={i}>{t.v}</em>
        ) : (
          t.v
        ),
      )}
    </>
  );
}

/* ---- collapsible section ---- */

/**
 * One section per scope level (Project / Document / Inline). Status lives on
 * the cards, not in the section structure: a section auto-expands while it
 * holds anything unresolved, and the badge counts only unresolved items.
 */
function Section({
  title,
  total,
  unresolved,
  children,
}: {
  title: string;
  total: number;
  unresolved: number;
  children: ReactNode;
}) {
  const [override, setOverride] = useState<boolean | null>(null);
  const expanded = override ?? unresolved > 0;
  if (total === 0) return null;
  return (
    <section>
      <h2>
        <button
          className={`rl-collapse${expanded ? "" : " collapsed"}`}
          onClick={() => setOverride(!expanded)}
        >
          <span className="rl-chevron" aria-hidden>
            ▸
          </span>
          {title}
          {unresolved > 0 && <span className="rl-count">{unresolved}</span>}
        </button>
      </h2>
      {expanded && children}
    </section>
  );
}

/* ---- cards ---- */

export function ReplyThread({
  replies,
  onEditReply,
}: {
  replies: Reply[] | undefined;
  /** present = the author's own entries get an edit affordance */
  onEditReply?: (index: number, text: string) => void;
}) {
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const [text, setText] = useState("");
  if (!replies?.length) return null;
  return (
    <div className="rl-thread">
      {replies.map((r, i) =>
        editIdx === i ? (
          <div key={i} className="rl-reply-form" onClick={(e) => e.stopPropagation()}>
            <textarea
              autoFocus
              rows={2}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (text.trim() && text.trim() !== r.text) onEditReply?.(i, text.trim());
                  setEditIdx(null);
                }
                if (e.key === "Escape") setEditIdx(null);
              }}
            />
          </div>
        ) : (
          <p key={i} className={`rl-thread-msg rl-thread-${r.by}`}>
            <span className="rl-thread-label">
              {r.by === "author" ? "you" : "agent"}
              {r.by === "author" && onEditReply && (
                <button
                  className="rl-thread-edit"
                  title="Edit this reply"
                  onClick={(e) => (e.stopPropagation(), setText(r.text), setEditIdx(i))}
                >
                  edit
                </button>
              )}
            </span>
            <RichText text={r.text} />
          </p>
        ),
      )}
    </div>
  );
}

function CommentCard({
  annotation,
  isProject,
  focused,
  actions,
}: {
  annotation: Annotation;
  isProject: boolean;
  focused: boolean;
  actions: CommentActions;
}) {
  const [replying, setReplying] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const quote = annotation.target?.selector?.[0]?.exact ?? null;
  const shortQuote = quote && quote.length > 90 ? quote.slice(0, 87) + "…" : quote;

  const submitReply = () => {
    if (!replyText.trim()) return;
    actions.onReply(annotation.id, isProject, replyText.trim());
    setReplyText("");
    setReplying(false);
  };

  const submitEdit = () => {
    if (!editText.trim() || editText.trim() === annotation.body.value) {
      setEditing(false);
      return;
    }
    actions.onEdit(annotation.id, isProject, editText.trim());
    setEditing(false);
  };

  return (
    <div
      className={`rl-card rl-card-${annotation.status}${focused ? " focused" : ""}`}
      data-comment-id={annotation.id}
      onClick={() => quote && actions.onFocus(annotation.id)}
    >
      {shortQuote && <blockquote>{shortQuote}</blockquote>}
      {annotation.status === "orphaned" && (
        <span
          className="rl-orphan-mark"
          title="The passage this comment pointed at has changed or been removed."
        >
          unanchored
        </span>
      )}
      {editing ? (
        <div className="rl-reply-form" onClick={(e) => e.stopPropagation()}>
          <textarea
            autoFocus
            rows={3}
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) (e.preventDefault(), submitEdit());
              if (e.key === "Escape") setEditing(false);
            }}
          />
        </div>
      ) : (
        <p className="rl-card-body">{annotation.body.value}</p>
      )}
      <ReplyThread
        replies={annotation.replies}
        onEditReply={(i, t) => actions.onEditReply(annotation.id, isProject, i, t)}
      />
      {annotation.status === "resolved" && !annotation.resolution?.note && (
        <span className="rl-resolved-mark">✓ resolved</span>
      )}
      {annotation.status === "addressed" && (
        <span
          className="rl-addressed-mark"
          title="The agent proposed this — accept to close the comment, or send it back with a reply."
        >
          awaiting your review
        </span>
      )}
      {annotation.resolution && annotation.resolution.note && (
        <p className={`rl-resolution rl-resolution-${annotation.resolution.action}`}>
          <span className="rl-thread-label">
            agent
          </span>
          <RichText text={annotation.resolution.note} />
        </p>
      )}
      {replying ? (
        <div className="rl-reply-form" onClick={(e) => e.stopPropagation()}>
          <textarea
            autoFocus
            rows={2}
            value={replyText}
            placeholder={
              annotation.status === "addressed"
                ? "Reply — sends the comment back to the agent"
                : "Reply — this reopens the comment for the agent"
            }
            onChange={(e) => setReplyText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) (e.preventDefault(), submitReply());
              if (e.key === "Escape") setReplying(false);
            }}
          />
        </div>
      ) : (
        <div className="rl-card-actions">
          {annotation.status === "addressed" ? (
            <>
              <button
                className="rl-accept"
                onClick={(e) => (e.stopPropagation(), actions.onMarkResolved(annotation.id, isProject))}
              >
                accept
              </button>
              <button
                title="Reply — sends the comment back to the agent"
                onClick={(e) => (e.stopPropagation(), setReplying(true))}
              >
                reply
              </button>
            </>
          ) : (
            <>
              {(annotation.resolution || annotation.replies?.length) && (
                <button onClick={(e) => (e.stopPropagation(), setReplying(true))}>reply</button>
              )}
              {(annotation.status === "open" || annotation.status === "orphaned") && (
                <button
                  onClick={(e) => (
                    e.stopPropagation(),
                    setEditText(annotation.body.value),
                    setEditing(true)
                  )}
                >
                  edit
                </button>
              )}
              {annotation.status !== "resolved" && (
                <button
                  onClick={(e) =>
                    (e.stopPropagation(), actions.onMarkResolved(annotation.id, isProject))
                  }
                >
                  resolve
                </button>
              )}
              {annotation.status === "resolved" && (
                <button
                  onClick={(e) => (e.stopPropagation(), actions.onReopen(annotation.id, isProject))}
                >
                  reopen
                </button>
              )}
            </>
          )}
          <button onClick={(e) => (e.stopPropagation(), actions.onDelete(annotation.id, isProject))}>
            delete
          </button>
        </div>
      )}
    </div>
  );
}

function NoteComposer({
  hasOpenDoc,
  onAddNote,
}: {
  hasOpenDoc: boolean;
  onAddNote(scope: "document" | "project", text: string): void;
}) {
  const [scope, setScope] = useState<"document" | "project" | null>(null);
  const [text, setText] = useState("");

  const submit = () => {
    if (!scope || !text.trim()) return;
    onAddNote(scope, text.trim());
    setText("");
    setScope(null);
  };

  if (!scope) {
    return (
      <div className="rl-note-buttons">
        <button disabled={!hasOpenDoc} onClick={() => setScope("document")} title="A note about this document as a whole">
          + document note
        </button>
        <button onClick={() => setScope("project")} title="A note about the whole project — e.g. request a new document">
          + project note
        </button>
      </div>
    );
  }
  return (
    <div className="rl-note-composer">
      <span className="rl-chip">{scope === "document" ? "document note" : "project note"}</span>
      <textarea
        autoFocus
        rows={3}
        value={text}
        placeholder={
          scope === "document"
            ? "About this document as a whole…"
            : "About the project — e.g. “add a deployment guide covering…”"
        }
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) (e.preventDefault(), submit());
          if (e.key === "Escape") setScope(null);
        }}
      />
    </div>
  );
}

/* ---- overflow menu for sidebar-wide actions ---- */

function ActionsMenu({
  copyableCount,
  onCopy,
  copied,
}: {
  copyableCount: number;
  onCopy(): void;
  copied: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  return (
    <div className="rl-actions" ref={rootRef}>
      <button
        className={`rl-actions-btn${open ? " open" : ""}`}
        title="Actions"
        aria-haspopup="menu"
        onClick={() => setOpen((o) => !o)}
      >
        ⋯
      </button>
      {open && (
        <div className="rl-menu" role="menu">
          <button
            role="menuitem"
            disabled={copyableCount === 0}
            title="Copy the open comments as markdown — for pasting into a chat"
            onClick={() => onCopy()}
          >
            {copied
              ? "copied ✓"
              : `copy ${copyableCount} open comment${copyableCount === 1 ? "" : "s"}`}
          </button>
        </div>
      )}
    </div>
  );
}

export function CommentSidebar({
  annotations,
  projectAnnotations,
  docPath,
  hasOpenDoc,
  focusedId,
  onAddNote,
  ...actions
}: Props) {
  const inline = annotations.filter((a) => a.target);
  const docNotes = annotations.filter((a) => !a.target);
  const [copied, setCopied] = useState(false);
  const copyableCount =
    annotations.filter(isActionable).length + projectAnnotations.filter(isActionable).length;
  const copyComments = () => {
    void navigator.clipboard
      .writeText(exportMarkdown(docPath, annotations, projectAnnotations))
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      });
  };

  // keep the focused card visible when focus comes from the document or
  // stepper. Scoped to the sidebar: the editor's highlight spans carry the
  // same data-comment-id, and a document-wide query finds those first.
  const asideRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!focusedId) return;
    asideRef.current
      ?.querySelector(`[data-comment-id="${CSS.escape(focusedId)}"]`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focusedId]);
  // unresolved first (open and unanchored alike); resolved dimmed at the bottom
  const byOpenFirst = (a: Annotation, b: Annotation) =>
    (a.status === "resolved" ? 1 : 0) - (b.status === "resolved" ? 1 : 0);
  const unresolvedCount = (items: Annotation[]) =>
    items.filter((a) => a.status !== "resolved").length;

  const cards = (items: Annotation[], isProject: boolean) =>
    [...items].sort(byOpenFirst).map((a) => (
      <CommentCard
        key={a.id}
        annotation={a}
        isProject={isProject}
        focused={a.id === focusedId}
        actions={actions}
      />
    ));

  const empty = annotations.length === 0 && projectAnnotations.length === 0;

  return (
    <aside className="rl-sidebar" ref={asideRef}>
      <div className="rl-sidebar-head">
        <NoteComposer hasOpenDoc={hasOpenDoc} onAddNote={onAddNote} />
        <ActionsMenu copyableCount={copyableCount} onCopy={copyComments} copied={copied} />
      </div>
      {empty && hasOpenDoc && (
        <p className="rl-muted rl-empty">Select a passage in the document to leave a comment.</p>
      )}
      <Section
        title="Project"
        total={projectAnnotations.length}
        unresolved={unresolvedCount(projectAnnotations)}
      >
        {cards(projectAnnotations, true)}
      </Section>
      <Section title="Document" total={docNotes.length} unresolved={unresolvedCount(docNotes)}>
        {cards(docNotes, false)}
      </Section>
      <Section title="Inline" total={inline.length} unresolved={unresolvedCount(inline)}>
        {cards(inline, false)}
      </Section>
    </aside>
  );
}
