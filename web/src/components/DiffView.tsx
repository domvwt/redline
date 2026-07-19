import { useEffect, useState } from "react";
import { diffLines } from "diff";
import { api } from "../api.ts";

interface Props {
  path: string;
  onMarkReviewed(): void;
  onClose(): void;
}

/** Line diff between the last-reviewed baseline and the current document. */
export function DiffView({ path, onMarkReviewed, onClose }: Props) {
  const [parts, setParts] = useState<ReturnType<typeof diffLines> | null>(null);

  useEffect(() => {
    void Promise.all([api.getBaseline(path), api.getDoc(path)]).then(([baseline, doc]) => {
      setParts(diffLines(baseline.markdown ?? "", doc.markdown));
    });
  }, [path]);

  if (!parts) return <div className="rl-diff rl-muted">loading…</div>;

  const changedCount = parts.filter((p) => p.added || p.removed).length;

  return (
    <div className="rl-diff">
      <div className="rl-diff-bar">
        <span className="rl-muted">
          {changedCount === 0 ? "No changes since you last reviewed." : `Changes since you last reviewed ${path}`}
        </span>
        <span>
          <button onClick={onClose}>back</button>{" "}
          <button className="rl-primary" onClick={onMarkReviewed}>
            mark reviewed
          </button>
        </span>
      </div>
      <div className="rl-diff-body">
        {parts.map((part, i) => (
          <pre
            key={i}
            className={part.added ? "rl-diff-add" : part.removed ? "rl-diff-del" : "rl-diff-ctx"}
          >
            {part.value}
          </pre>
        ))}
      </div>
    </div>
  );
}
