import { useEffect, useState } from "react";
import type { Annotation } from "@redline/shared";
import { ReplyThread, RichText } from "./CommentSidebar.tsx";

export interface FocusEntry {
  annotation: Annotation;
  isProject: boolean;
}

interface Props {
  entries: FocusEntry[];
  index: number;
  onNavigate(next: number): void;
  onClose(): void;
  onAccept(id: string, isProject: boolean): void;
  onReply(id: string, isProject: boolean, text: string): void;
  onEditReply(id: string, isProject: boolean, index: number, text: string): void;
}

/**
 * Jira-board-style review mode: a centred modal over a dimmed backdrop walks
 * one comment at a time (←/→) through everything still needing a look. The
 * conversation sits on top; the quoted passage, shown in its surrounding
 * context, sits in its own window below — so the card is self-contained.
 * Accepting lets the queue slide forward; replying advances explicitly.
 */
export function FocusPanel({
  entries,
  index,
  onNavigate,
  onClose,
  onAccept,
  onReply,
  onEditReply,
}: Props) {
  const clamped = Math.min(index, entries.length - 1);
  const entry = entries[clamped];
  const [replying, setReplying] = useState(false);
  const [replyText, setReplyText] = useState("");

  useEffect(() => {
    setReplying(false);
    setReplyText("");
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

  const submitReply = () => {
    if (!replyText.trim()) return;
    onReply(a.id, entry.isProject, replyText.trim());
    setReplyText("");
    setReplying(false);
    // replying hands the comment back to the agent — move on to the next one
    if (entries.length > 1) onNavigate((clamped + 1) % entries.length);
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
      <p className="rl-card-body">{a.body.value}</p>
      <ReplyThread
        replies={a.replies}
        onEditReply={(i, t) => onEditReply(a.id, entry.isProject, i, t)}
      />
      {a.resolution?.note && (
        <p className={`rl-resolution rl-resolution-${a.resolution.action}`}>
          <span className="rl-thread-label">
            agent
          </span>
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
            <button className="rl-accept" onClick={() => onAccept(a.id, entry.isProject)}>
              accept
            </button>
          )}
          <button onClick={() => setReplying(true)}>reply</button>
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
