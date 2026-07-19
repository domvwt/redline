import { useEffect, useMemo, useState } from "react";
import {
  applyEdits,
  buildHandoffPrompt,
  parseReply,
  PROJECT_PATH,
} from "@redline/shared";
import type { Annotation, EditOutcome, HandoffComment, HandoffDoc } from "@redline/shared";
import { api } from "../api.ts";
import { proposeFromReply, writeDocAsAgent } from "../api-browser.ts";

/**
 * The static build's agent leg: copy a self-contained prompt into any AI
 * chat, paste the structured reply back, and redline applies the edits and
 * records the proposals. Only ever rendered in STATIC_MODE (lazy-loaded, so
 * the daemon bundle never ships it).
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
  edits: Array<{ path: string; search: string; outcome: EditOutcome }>;
  proposals: number;
  skipped: string[];
}

export function HandoffControls({
  currentPath,
  onNotice,
}: {
  currentPath: string | null;
  onNotice: (message: string) => void;
}) {
  const [modalOpen, setModalOpen] = useState(false);
  const [reply, setReply] = useState("");
  const [report, setReport] = useState<ApplyReport | null>(null);
  const [applying, setApplying] = useState(false);

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
      onNotice(
        `Copied ${count} comment${count === 1 ? "" : "s"} — paste into any AI chat, then bring its reply back here.`,
      );
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

      const report: ApplyReport = { edits: [], proposals: 0, skipped: [...parsed.warnings] };

      const byPath = new Map<string, typeof parsed.edits>();
      for (const e of parsed.edits) {
        byPath.set(e.path, [...(byPath.get(e.path) ?? []), e]);
      }
      for (const [p, edits] of byPath) {
        let markdown: string;
        try {
          ({ markdown } = await api.getDoc(p));
        } catch {
          for (const e of edits) {
            report.edits.push({
              path: p,
              search: e.search,
              outcome: { status: "failed", reason: `no such document: ${p}` },
            });
          }
          continue;
        }
        const result = applyEdits(markdown, edits);
        edits.forEach((e, i) => {
          report.edits.push({ path: p, search: e.search, outcome: result.outcomes[i] });
        });
        if (result.markdown !== markdown) await writeDocAsAgent(p, result.markdown);
      }

      for (const r of parsed.resolutions) {
        const p = idToPath.get(r.id);
        if (!p) {
          report.skipped.push(`resolution for unknown comment id ${r.id}`);
          continue;
        }
        const applied = await proposeFromReply(p, r.id, r.action, r.note);
        if (applied) report.proposals++;
        else report.skipped.push(`comment ${r.id} was already resolved — proposal skipped`);
      }

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

  const outcomeLabel = (o: EditOutcome): string => {
    switch (o.status) {
      case "applied":
        return "applied";
      case "fuzzy":
        return o.errors > 0 ? `applied (fuzzy, ${o.errors} differences)` : "applied (rewrapped)";
      case "ambiguous":
        return `not applied — matches ${o.occurrences} places`;
      case "failed":
        return `not applied — ${o.reason}`;
    }
  };

  const failures = report?.edits.filter(
    (e) => e.outcome.status === "ambiguous" || e.outcome.status === "failed",
  );

  return (
    <>
      <button
        className="rl-handoff-btn"
        onClick={() => void copyHandoff()}
        title="Copy the document and open comments as a prompt for any AI chat"
      >
        copy for AI
      </button>
      <button
        className="rl-handoff-btn"
        onClick={() => setModalOpen(true)}
        title="Paste the assistant's reply to apply its edits and proposals"
      >
        paste reply
      </button>

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
                  placeholder="Paste the full reply here — redline picks out the edit blocks and resolution notes."
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                />
                {parsed && (
                  <div className="rl-handoff-summary">
                    <span>
                      {parsed.edits.length} edit{parsed.edits.length === 1 ? "" : "s"} ·{" "}
                      {parsed.resolutions.length} resolution
                      {parsed.resolutions.length === 1 ? "" : "s"}
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
                      (parsed.edits.length === 0 && parsed.resolutions.length === 0)
                    }
                    onClick={() => void applyReply()}
                  >
                    {applying ? "applying…" : "apply"}
                  </button>
                  <button className="rl-handoff-cancel" onClick={close}>
                    cancel
                  </button>
                </div>
              </>
            ) : (
              <>
                <h3 className="rl-handoff-title">Reply applied</h3>
                <div className="rl-handoff-report">
                  <p>
                    {report.edits.filter((e) => e.outcome.status === "applied" || e.outcome.status === "fuzzy").length}{" "}
                    of {report.edits.length} edits applied · {report.proposals} proposal
                    {report.proposals === 1 ? "" : "s"} now awaiting your review
                  </p>
                  {failures && failures.length > 0 && (
                    <ul className="rl-handoff-failures">
                      {failures.map((e, i) => (
                        <li key={i}>
                          <code>{e.search.length > 60 ? e.search.slice(0, 60) + "…" : e.search}</code>{" "}
                          — {outcomeLabel(e.outcome)}
                        </li>
                      ))}
                    </ul>
                  )}
                  {report.skipped.map((w, i) => (
                    <div key={i} className="rl-handoff-warning">
                      ⚠ {w}
                    </div>
                  ))}
                  <p className="rl-handoff-hint">
                    Edited documents show a <strong>● changes</strong> button — review the diff
                    there, and accept or reply to each proposal on its card.
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
