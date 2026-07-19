import { useEffect, useRef, useState } from "react";
import type { SelectionInfo } from "../editor/EditorPane.tsx";

interface Props {
  selection: SelectionInfo;
  text: string;
  onText(text: string): void;
  onSubmit(): void;
  onCancel(): void;
}

/** Review-mode comment box: opens focused the moment a selection settles. */
export function CommentPopover({ selection, text, onText, onSubmit, onCancel }: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Position is captured when the popover opens and stays put.
  const [pos] = useState(() => ({
    top: Math.min(selection.rect.top + 8, window.innerHeight - 180),
    left: Math.min(Math.max(12, selection.rect.left - 40), window.innerWidth - 360),
  }));

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  return (
    <div
      style={{ position: "fixed", top: pos.top, left: pos.left, zIndex: 40 }}
      className="rl-popover rl-popover-form"
    >
      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => onText(e.target.value)}
        placeholder="What should change here?"
        rows={3}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (text.trim()) onSubmit();
          }
          if (e.key === "Escape") onCancel();
        }}
      />
      <div className="rl-popover-actions">
        <span className="rl-key-hint">↵ send · shift+↵ newline · esc</span>
        <button className="rl-primary" disabled={!text.trim()} onClick={onSubmit}>
          Comment
        </button>
      </div>
    </div>
  );
}
