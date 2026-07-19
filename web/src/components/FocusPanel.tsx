import { useEffect, useState } from "react";
import type { Annotation } from "@redline/shared";
import { ReplyThread, RichText } from "./CommentSidebar.tsx";

export interface FocusEntry {
  annotation: Annotation;
  isProject: boolean;
}

interface Props {
  /** ALL comments (resolved included), in stable document order */
  entries: FocusEntry[];
  index: number;
  onNavigate(next: number): void;
  onClose(): void;
  /** accept a proposal, or author-close an open comment — same transition */
  onMarkResolved(id: string, isProject: boolean): void;
  onReopen(id: string, isProject: boolean): void;
  onDelete(id: string, isProject: boolean): void;
  onReply(id: string, isProject: boolean, text: string): void;
  onEdit(id: string, isProject: boolean, text: string): void;
  onEditReply(id: string, isProject: boolean, index: number, text: string): void;
}

/**
 * Jira-board-style review mode: a centred modal over a dimmed backdrop walks
 * one comment at a time (←/→). The conversation sits on top; the quoted
 * passage, in its surrounding context, sits in its own window below. Every
 * sidebar-card action is available here too — resolved comments included
 * (reopen/delete). Accepting or replying advances to the next comment that
 * still needs attention.
 */
export function FocusPanel({
  entries,
  index,
  onNavigate,
  onClose,
  onMarkResolved,
  onReopen,
  onDelete,
  onReply,
  onEdit,
  onEditReply,
}: Props) {
  const clamped = Math.min(index, entries.length - 1);
  const entry = entries[clamped];
  const [replying, setReplying] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");

  useEffect(() => {
    setReplying(false);
    setReplyText("");
    setEditing(false);
  }, [entry?.annotation.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable]")) return;
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft") onNavigate((clamped - 1 + entries.length) % entries.length);
      if (e.key === "ArrowRight") onNavigate((clamped + 1) % entries.length);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [clamped, entries.length, onClose, onNavigate]);

  if (!entry) return null;
  const a = entry.annotation;
  const selector = a.target?.selector?.[0] ?? null;
  const quote = selector?.exact ?? null;

  /** move to the next comment still needing a look; stay put if none */
  const advancePastCurrent = () => {
    for (let step = 1; step < entries.length; step++) {
      const idx = (clamped + step) % entries.length;
      if (entries[idx].annotation.status !== "resolved") {
        onNavigate(idx);
        return;
      }
    }
  };

  const submitReply = () => {
    if (!replyText.trim()) return;
    onReply(a.id, entry.isProject, replyText.trim());
    setReplyText("");
    setReplying(false);
    advancePastCurrent();
  };

  const submitEdit = () => {
    if (editText.trim() && editText.trim() !== a.body.value) {
      onEdit(a.id, entry.isProject, editText.trim());
    }
    setEditing(false);
  };

  return (
    <>
    <div className="rl-focus-backdrop" onClick={onClose} />
    <div className="rl-focus-panel">
      <div className="rl-focus-head">
        <span className="rl-chip">
          {entry.isProject ? "project note" : quote ? "inline comment" : "document note"}
        </span>
        {a.status === "addressed" && <span className="rl-addressed-mark">awaiting your review</span>}
        {a.status === "orphaned" && <span className="rl-orphan-mark">unanchored</span>}
        {a.status === "resolved" && <span className="rl-resolved-mark">✓ resolved</span>}
        <div className="rl-focus-nav">
          <button
            onClick={() => onNavigate((clamped - 1 + entries.length) % entries.length)}
            title="Previous (←)"
          >
            ‹
          </button>
          <span className="rl-focus-count">
            {clamped + 1} / {entries.length}
          </span>
          <button
            onClick={() => onNavigate((clamped + 1) % entries.length)}
            title="Next (→)"
          >
            ›
          </button>
          <button className="rl-focus-close" onClick={onClose} title="Exit focus mode (Esc)">
            ✕
          </button>
        </div>
      </div>
      {editing ? (
        <div className="rl-reply-form">
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
        <p className="rl-card-body">{a.body.value}</p>
      )}
      <ReplyThread
        replies={a.replies}
        onEditReply={(i, t) => onEditReply(a.id, entry.isProject, i, t)}
      />
      {a.resolution?.note && (
        <p className={`rl-resolution rl-resolution-${a.resolution.action}`}>
          <span className="rl-thread-label">agent</span>
          <RichText text={a.resolution.note} />
        </p>
      )}
      {replying ? (
        <div className="rl-reply-form">
          <textarea
            autoFocus
            rows={2}
            value={replyText}
            placeholder={
              a.status === "addressed"
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
          {a.status === "addressed" && (
            <button
              className="rl-accept"
              onClick={() => {
                onMarkResolved(a.id, entry.isProject);
                advancePastCurrent();
              }}
            >
              accept
            </button>
          )}
          {(a.status === "open" || a.status === "orphaned") && (
            <>
              <button onClick={() => (setEditText(a.body.value), setEditing(true))}>edit</button>
              <button onClick={() => onMarkResolved(a.id, entry.isProject)}>resolve</button>
            </>
          )}
          {a.status === "resolved" && (
            <button onClick={() => onReopen(a.id, entry.isProject)}>reopen</button>
          )}
          <button onClick={() => setReplying(true)}>reply</button>
          <button onClick={() => onDelete(a.id, entry.isProject)}>delete</button>
        </div>
      )}
      {quote && (
        <div className="rl-focus-passage">
          <span className="rl-focus-passage-label">passage</span>
          <p className="rl-focus-passage-text">
            {selector!.prefix && <span className="rl-focus-context">…{selector!.prefix}</span>}
            <mark>{quote}</mark>
            {selector!.suffix && <span className="rl-focus-context">{selector!.suffix}…</span>}
          </p>
        </div>
      )}
    </div>
    </>
  );
}
