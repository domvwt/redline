import { useEffect, useMemo, useState } from "react";
import { buildHandoffPrompt, parseReply, PROJECT_PATH } from "@redline/shared";
import type { Annotation, HandoffComment, HandoffDoc } from "@redline/shared";
import { api } from "../api.ts";
import { proposeFromReply, writeDocAsAgent } from "../api-browser.ts";

/**
 * The static build's agent leg: copy a self-contained prompt into any AI
 * chat; the assistant responds to each comment and returns the complete
 * revised document(s); pasting the reply applies the new versions and
 * records the responses as proposals. Only ever rendered in STATIC_MODE
 * (lazy-loaded, so the daemon bundle never ships it).
 */

function toHandoffComment(a: Annotation): HandoffComment {
  return {
    id: a.id,
    quote: a.target?.selector[0].exact ?? null,
    prefix: a.target?.selector[0].prefix ?? null,
    suffix: a.target?.selector[0].suffix ?? null,
    comment: a.body.value,
    thread: (a.replies ?? []).map((r) => ({ by: r.by, text: r.text })),
  };
}

const isOpen = (a: Annotation) => a.status === "open" || a.status === "orphaned";

interface ApplyReport {
  updated: string[];
  unchanged: string[];
  proposals: number;
  warnings: string[];
}

export function HandoffControls({
  currentPath,
  readyCount,
  onNotice,
}: {
  currentPath: string | null;
  /** open/orphaned comments in view (current doc + project) — drives the
   *  "ready to hand off" nudge */
  readyCount: number;
  onNotice: (message: string) => void;
}) {
  const [modalOpen, setModalOpen] = useState(false);
  const [reply, setReply] = useState("");
  const [report, setReport] = useState<ApplyReport | null>(null);
  const [applying, setApplying] = useState(false);
  // survives the trip to the chat tab (and a reload): copied but not yet
  // pasted back — the UI keeps pointing at the next step until then
  const [awaitingReply, setAwaitingReply] = useState(
    () => localStorage.getItem("redline-handoff-pending") === "1",
  );
  const setPending = (on: boolean) => {
    setAwaitingReply(on);
    if (on) localStorage.setItem("redline-handoff-pending", "1");
    else localStorage.removeItem("redline-handoff-pending");
  };

  const parsed = useMemo(
    () => (reply.trim() ? parseReply(reply, { defaultPath: currentPath ?? undefined }) : null),
    [reply, currentPath],
  );

  const copyHandoff = async () => {
    try {
      const docs: HandoffDoc[] = [];
      for (const entry of await api.tree()) {
        const sidecar = await api.getComments(entry.path);
        const comments = sidecar.annotations.filter(isOpen).map(toHandoffComment);
        if (comments.length === 0) continue;
        const { markdown } = await api.getDoc(entry.path);
        docs.push({ path: entry.path, markdown, comments });
      }
      const projectNotes = (await api.getComments(PROJECT_PATH)).annotations
        .filter(isOpen)
        .map(toHandoffComment);
      const count = docs.reduce((n, d) => n + d.comments.length, 0) + projectNotes.length;
      if (count === 0) {
        onNotice("No open comments to hand off — highlight a passage and type first.");
        return;
      }
      await navigator.clipboard.writeText(buildHandoffPrompt(docs, { projectNotes }));
      setPending(true);
      onNotice(`Copied ${count} comment${count === 1 ? "" : "s"} — paste into any AI chat.`);
    } catch (err) {
      onNotice(String(err));
    }
  };

  const applyReply = async () => {
    if (!parsed || applying) return;
    setApplying(true);
    try {
      // ids are unique across the project — map each to its sidecar
      const idToPath = new Map<string, string>();
      const paths = [PROJECT_PATH, ...(await api.tree()).map((e) => e.path)];
      for (const p of paths) {
        for (const a of (await api.getComments(p)).annotations) idToPath.set(a.id, p);
      }

      const report: ApplyReport = {
        updated: [],
        unchanged: [],
        proposals: 0,
        warnings: [...parsed.warnings],
      };

      for (const doc of parsed.documents) {
        let current: string;
        try {
          ({ markdown: current } = await api.getDoc(doc.path));
        } catch {
          report.warnings.push(`no such document: ${doc.path} — skipped`);
          continue;
        }
        if (doc.markdown === current) {
          report.unchanged.push(doc.path);
          continue;
        }
        if (doc.markdown.length < current.length / 2) {
          report.warnings.push(
            `${doc.path} came back less than half its previous size — check the diff carefully`,
          );
        }
        await writeDocAsAgent(doc.path, doc.markdown);
        report.updated.push(doc.path);
      }

      for (const r of parsed.responses) {
        const p = idToPath.get(r.id);
        if (!p) {
          report.warnings.push(`response for unknown comment id ${r.id}`);
          continue;
        }
        const applied = await proposeFromReply(p, r.id, r.action, r.note);
        if (applied) report.proposals++;
        else report.warnings.push(`comment ${r.id} was already resolved — response skipped`);
      }

      setPending(false);
      setReport(report);
    } catch (err) {
      onNotice(String(err));
    } finally {
      setApplying(false);
    }
  };

  const close = () => {
    setModalOpen(false);
    setReply("");
    setReport(null);
  };

  useEffect(() => {
    if (!modalOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modalOpen]);

  return (
    <>
      {awaitingReply ? (
        <>
          <span className="rl-handoff-waiting">waiting for reply</span>
          <button
            className="rl-handoff-btn rl-handoff-primary"
            onClick={() => setModalOpen(true)}
            title="Paste the assistant's reply to apply its revision and responses"
          >
            paste reply
          </button>
        </>
      ) : readyCount > 0 ? (
        <button
          className="rl-handoff-btn"
          onClick={() => void copyHandoff()}
          title="Copy your documents and open comments as a prompt for any AI chat"
        >
          copy for AI
        </button>
      ) : null}

      {modalOpen && (
        <>
          <div className="rl-focus-backdrop" onClick={close} />
          <div className="rl-focus-panel rl-handoff-panel">
            {report === null ? (
              <>
                <h3 className="rl-handoff-title">Paste the assistant's reply</h3>
                <textarea
                  className="rl-handoff-input"
                  autoFocus
                  placeholder="Paste the assistant's full reply — redline reads its comment responses and the revised document."
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                />
                {parsed && (
                  <div className="rl-handoff-summary">
                    <span>
                      {parsed.documents.length} revised document
                      {parsed.documents.length === 1 ? "" : "s"} · {parsed.responses.length}{" "}
                      comment response{parsed.responses.length === 1 ? "" : "s"}
                    </span>
                    {parsed.warnings.map((w, i) => (
                      <div key={i} className="rl-handoff-warning">
                        ⚠ {w}
                      </div>
                    ))}
                  </div>
                )}
                <div className="rl-handoff-actions">
                  <button
                    className="rl-handoff-apply"
                    disabled={
                      applying ||
                      !parsed ||
                      (parsed.documents.length === 0 && parsed.responses.length === 0)
                    }
                    onClick={() => void applyReply()}
                  >
                    {applying ? "applying…" : "apply"}
                  </button>
                  <button className="rl-handoff-cancel" onClick={close}>
                    cancel
                  </button>
                  <button
                    className="rl-handoff-cancel rl-handoff-recopy"
                    title="Put the handoff prompt back on the clipboard"
                    onClick={() => void copyHandoff()}
                  >
                    copy the prompt again
                  </button>
                </div>
              </>
            ) : (
              <>
                <h3 className="rl-handoff-title">Reply applied</h3>
                <div className="rl-handoff-report">
                  <p>
                    {report.updated.length === 0
                      ? "No documents changed"
                      : `Updated ${report.updated.join(", ")}`}
                    {report.unchanged.length > 0 &&
                      ` · ${report.unchanged.join(", ")} came back identical`}{" "}
                    · {report.proposals} response{report.proposals === 1 ? "" : "s"} now awaiting
                    your review
                  </p>
                  {report.warnings.map((w, i) => (
                    <div key={i} className="rl-handoff-warning">
                      ⚠ {w}
                    </div>
                  ))}
                  <p className="rl-handoff-hint">
                    Updated documents show a <strong>● changes</strong> button — review the diff
                    there, and accept or reply to each response on its card.
                  </p>
                </div>
                <div className="rl-handoff-actions">
                  <button className="rl-handoff-apply" onClick={close}>
                    done
                  </button>
                </div>
              </>
            )}
          </div>
        </>
      )}
    </>
  );
}

export default HandoffControls;
