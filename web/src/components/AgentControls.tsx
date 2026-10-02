import { useState } from "react";
import type { AgentStatus } from "@redline/shared";
import { api } from "../api.ts";

/**
 * The daemon build's agent leg: when an agent is blocked in `redline wait`,
 * Send wakes it for the next round — no trip to the terminal. A send made
 * while it's mid-pass queues and wakes the next wait at once.
 */
export function AgentControls({
  status,
  readyCount,
  onNotice,
}: {
  status: AgentStatus | null;
  /** open/orphaned comments across the project — what a send hands over */
  readyCount: number;
  onNotice: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  if (!status) return null;

  const send = async (action: "send" | "done") => {
    setBusy(true);
    try {
      await api.sendHandoff!(action);
      if (action === "done") onNotice("Review finished — the agent stops listening.");
    } catch (err) {
      onNotice(String(err));
    } finally {
      setBusy(false);
    }
  };

  if (status.state === "absent") {
    return (
      <span
        className="rl-agent"
        title="Run /redline-comments in your terminal: after its first pass the agent listens here, and Send hands it each new round"
      >
        {status.finished
          ? "review finished"
          : status.pending
            ? "sent — no agent listening"
            : "no agent · run /redline-comments"}
      </span>
    );
  }

  const label =
    status.state === "working"
      ? status.pending
        ? "agent working · next round queued"
        : "agent working…"
      : "agent listening";
  return (
    <>
      <span className={`rl-agent rl-agent-${status.state}`}>
        <span className="rl-agent-dot" aria-hidden="true" />
        {label}
      </span>
      <button
        className="rl-action rl-action-primary"
        disabled={busy || readyCount === 0 || status.pending}
        onClick={() => void send("send")}
        title={
          readyCount === 0
            ? "No open comments — highlight a passage and type, or reply to a proposal"
            : "Hand your open comments and replies to the agent"
        }
      >
        send to agent ({readyCount}) →
      </button>
      <button
        className="rl-action"
        disabled={busy}
        onClick={() => void send("done")}
        title="This review is finished — the agent stops listening"
      >
        done
      </button>
    </>
  );
}
