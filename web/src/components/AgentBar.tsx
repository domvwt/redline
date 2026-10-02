import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { AgentStatus } from "@redline/shared";
import { api } from "../api.ts";

const START_COMMAND = "/redline-comments";
const SEND_KEYS = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘↵" : "Ctrl ↵";
const COLLAPSED_KEY = "redline:agent-bar-collapsed";
const DISMISSED_KEY = "redline:agent-bar-dismissed";

function readValue(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeValue(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // storage blocked: the choice just doesn't outlive the tab
  }
}

/** a text field has the keyboard: ⌘↵ there belongs to it */
const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])") !== null;

type Tone = "listening" | "working" | "absent" | "stranded" | "stopped";

/**
 * The daemon build's agent leg, docked under the document. One fixed size
 * in every state — status, detail, one action, and a menu — so only its
 * text changes and nothing jumps while you read.
 */
export function AgentBar({
  status,
  readyCount,
  onNotice,
}: {
  status: AgentStatus | null;
  /** open/orphaned comments across the project — what a send hands over */
  readyCount: number;
  onNotice: (message: string) => void;
}) {
  const [busy, setBusy] = useState<"send" | "done" | "drop" | null>(null);
  const [collapsed, setCollapsed] = useState(() => readValue(COLLAPSED_KEY) === "1");
  // the session whose "Agent stopped" was dismissed: the next session's shows
  const [dismissedSession, setDismissedSession] = useState(() => readValue(DISMISSED_KEY));
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const moreBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    moreRef.current?.querySelector<HTMLButtonElement>("[role='menuitem']:not(:disabled)")?.focus();
    // focusin, not blur: macOS Safari and Firefox don't focus a clicked
    // button, so a blur would close the menu before its item's click lands
    const close = (e: Event) => {
      if (!moreRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("focusin", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("focusin", close);
    };
  }, [menuOpen]);

  // a daemon older than this page reports another shape: show no progress, not a crash
  const round = Array.isArray(status?.round?.held) ? status.round : null;
  // open comments the agent isn't holding: what a mid-pass send would queue
  const unsent = Math.max(0, readyCount - (round?.held.length ?? 0));
  const canSend =
    !!status &&
    !busy &&
    !status.pending &&
    !status.stopping &&
    ((status.state === "listening" && readyCount > 0) || (status.state === "working" && unsent > 0));

  const handoff = async (action: "send" | "done" | "drop") => {
    setBusy(action);
    try {
      await api.sendHandoff!(action);
    } catch (err) {
      onNotice(String(err));
    } finally {
      setBusy(null);
    }
  };

  const sendRef = useRef<() => boolean>(() => false);
  sendRef.current = () => {
    if (!canSend) return false;
    void handoff("send");
    return true;
  };
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !typing(e.target) && sendRef.current()) {
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!status) return null;
  const sessionKey = status.session ?? "";
  const dismissed = dismissedSession === sessionKey;

  const setCollapsedTo = (value: boolean) => {
    setCollapsed(value);
    writeValue(COLLAPSED_KEY, value ? "1" : null);
    setMenuOpen(false);
    // keep the keyboard on the bar: the control it was on just unmounted
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>(value ? ".rl-agent-pill" : ".rl-agent-more-btn")?.focus(),
    );
  };

  const dismiss = () => {
    setDismissedSession(sessionKey);
    writeValue(DISMISSED_KEY, sessionKey);
  };

  // kept inside the menu: Escape mustn't reach App's focus-mode handler
  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!menuOpen) return;
    if (e.key === "Escape") {
      e.stopPropagation();
      setMenuOpen(false);
      moreBtnRef.current?.focus();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const items = [
        ...(moreRef.current?.querySelectorAll<HTMLButtonElement>("[role='menuitem']:not(:disabled)") ?? []),
      ];
      const at = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = at < 0 ? (e.key === "ArrowDown" ? 0 : items.length - 1) : at + (e.key === "ArrowDown" ? 1 : -1);
      items[(next + items.length) % items.length]?.focus();
    }
  };

  const copyCommand = () => {
    // navigator.clipboard is undefined outside a secure context
    (navigator.clipboard?.writeText(START_COMMAND) ?? Promise.reject()).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => onNotice(`Run ${START_COMMAND} in Claude Code, in this folder`),
    );
  };

  const copyButton = (
    <button
      className="rl-agent-act rl-agent-act-outline"
      onClick={copyCommand}
      title="Copy the command that starts an agent — run it in Claude Code, in this folder"
    >
      {copied ? (
        "Copied ✓"
      ) : (
        <>
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="9" y="9" width="12" height="12" rx="2" />
            <path d="M5 15V5a2 2 0 0 1 2-2h10" />
          </svg>
          <code>{START_COMMAND}</code>
        </>
      )}
    </button>
  );
  const progress = round ? (
    <>
      {round.total <= 12 && (
        <span className="rl-agent-segments" aria-hidden="true">
          {Array.from({ length: round.total }, (_, i) => (
            <span key={i} className={i < round.answered ? "done" : undefined} />
          ))}
        </span>
      )}
      <span>
        {round.answered} of {round.total} answered
      </span>
    </>
  ) : null;

  let tone: Tone;
  let label: string;
  let detail: ReactNode;
  let action: ReactNode;
  if (status.state === "listening") {
    tone = "listening";
    label = "Listening";
    detail =
      readyCount > 0 ? (
        <span>
          <b>{readyCount} ready</b> to send
        </span>
      ) : (
        <span>Nothing to send</span>
      );
    action =
      status.pending || busy === "send" ? (
        <button className="rl-agent-act rl-agent-act-sending" disabled>
          Sending…
        </button>
      ) : (
        <button
          className={`rl-agent-act ${readyCount > 0 ? "rl-agent-act-primary" : "rl-agent-act-off"}`}
          disabled={!canSend}
          onClick={() => void handoff("send")}
          title={
            readyCount > 0
              ? `Hand your open comments and replies to the agent (${SEND_KEYS})`
              : "No open comments — highlight a passage and type, or reply to a proposal"
          }
        >
          Send to agent{readyCount > 0 && <kbd>{SEND_KEYS}</kbd>}
        </button>
      );
  } else if (status.state === "working") {
    tone = "working";
    label = status.stopping ? "Stopping" : "Working";
    detail = progress ?? <span>{status.stopping ? "Finishing its current pass" : "Working through your comments"}</span>;
    action = status.stopping ? (
      <button className="rl-agent-act rl-agent-act-outline rl-agent-act-quiet" disabled>
        {status.pending ? "Then one more round" : "Stops after this pass"}
      </button>
    ) : status.pending || busy === "send" ? (
      <button className="rl-agent-act rl-agent-act-outline rl-agent-act-quiet" disabled>
        Next round queued
      </button>
    ) : (
      <button
        className="rl-agent-act rl-agent-act-outline"
        disabled={!canSend}
        onClick={() => void handoff("send")}
        title={`The agent takes these as soon as it finishes this round (${SEND_KEYS})`}
      >
        {unsent > 0 ? `Queue ${unsent} →` : "Queue"}
      </button>
    );
  } else if (status.pending) {
    tone = "stranded";
    label = "Nobody listening";
    detail = <span>Sent, waiting for an agent</span>;
    action = copyButton;
  } else if (status.finished && !dismissed) {
    tone = "stopped";
    label = "Agent stopped";
    detail = status.rounds > 0 && <span>after {status.rounds} round{status.rounds === 1 ? "" : "s"}</span>;
    action = (
      <button className="rl-agent-act rl-agent-act-outline" onClick={dismiss}>
        Dismiss
      </button>
    );
  } else {
    tone = "absent";
    label = "No agent";
    detail =
      readyCount > 0 ? (
        <span>
          <b>{readyCount} ready</b> · start one in a terminal
        </span>
      ) : (
        <span>Start one in a terminal</span>
      );
    action = copyButton;
  }

  const dot =
    tone === "stopped" ? (
      <span className="rl-agent-check" aria-hidden="true">
        ✓
      </span>
    ) : (
      <span className="rl-agent-dot" aria-hidden="true" />
    );

  if (collapsed) {
    return (
      <div className="rl-agent-dock">
        <div className="rl-agent-row">
          <button
            className={`rl-agent-pill rl-agent-${tone}`}
            onClick={() => setCollapsedTo(false)}
            aria-label={`Agent: ${label}${readyCount > 0 ? `, ${readyCount} ready` : ""} — expand`}
            aria-expanded="false"
          >
            {dot}
            {readyCount > 0 && <span>{readyCount}</span>}
            <span className="rl-agent-chevron" aria-hidden="true">
              ⌃
            </span>
          </button>
        </div>
      </div>
    );
  }

  // Done means something while an agent could act on it, and a second one gives
  // up on an agent that died mid-pass; with none, Drop withdraws a stranded send
  const stopItem = status.stopping
    ? { action: "done" as const, label: "Stop waiting", hint: "Treat the agent as stopped — for when its session has ended." }
    : status.state === "absent"
      ? { action: "drop" as const, label: "Drop the send", hint: "Nobody will pick it up. Your comments stay as they are." }
      : {
          action: "done" as const,
          label: "Done for now",
          hint: "The agent finishes what it's doing, then stops listening. Comments stay as they are.",
        };
  const canStop = status.state !== "absent" || status.pending;
  return (
    <div className="rl-agent-dock">
      <div className="rl-agent-row">
        <section className={`rl-agent-bar rl-agent-${tone}`} aria-label="Agent">
          <span className="rl-agent-status" aria-live="polite">
            {dot}
            <span className="rl-agent-label">{label}</span>
          </span>
          <span className="rl-agent-sep" aria-hidden="true" />
          <span className="rl-agent-detail">{detail}</span>
          {action}
          <div
            className="rl-agent-more"
            ref={moreRef}
            onKeyDown={onMenuKey}
          >
            <button
              ref={moreBtnRef}
              className={`rl-agent-more-btn${menuOpen ? " open" : ""}`}
              aria-label="More agent actions"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((v) => !v)}
            >
              ⋯
            </button>
            {menuOpen && (
              <div className="rl-agent-menu" role="menu">
                {canStop && (
                  <button
                    role="menuitem"
                    disabled={!!busy}
                    onClick={() => {
                      setMenuOpen(false);
                      moreBtnRef.current?.focus();
                      void handoff(stopItem.action);
                    }}
                  >
                    <b>{stopItem.label}</b>
                    <span>{stopItem.hint}</span>
                  </button>
                )}
                <button role="menuitem" onClick={() => setCollapsedTo(true)}>
                  <b>Collapse bar</b>
                  <span>Shrink to a dot until you open it again.</span>
                </button>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
