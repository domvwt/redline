/**
 * open      — awaiting Claude (or newly created)
 * addressed — Claude proposed a resolution/decline; awaiting the author's
 *             verdict (accept → resolved, reject-with-reply → open)
 * resolved  — closed by the author; only the author moves a comment here
 * orphaned  — the anchored passage no longer exists in the document
 */
export type AnnotationStatus = "open" | "addressed" | "resolved" | "orphaned";

export type ResolutionAction = "resolved" | "declined";

export interface TextQuoteSelector {
  type: "TextQuoteSelector";
  exact: string;
  prefix: string;
  suffix: string;
}

export interface TextPositionSelector {
  type: "TextPositionSelector";
  start: number;
  end: number;
}

export interface Resolution {
  action: ResolutionAction;
  note: string;
}

export interface Reply {
  /** "claude" is the historic wire value for agent entries; new non-Claude
   *  agents may write "agent" — the UI renders both as "agent" */
  by: "author" | "claude" | "agent";
  text: string;
  at: string;
  /** set on agent entries folded in from a resolution */
  action?: ResolutionAction;
}

export interface Annotation {
  id: string;
  created: string;
  modified: string;
  body: { type: "TextualBody"; value: string };
  /** null = unanchored note (applies to the whole document, or — when it
   *  lives in the project sidecar — to the whole project) */
  target: {
    selector: [TextQuoteSelector, TextPositionSelector];
  } | null;
  status: AnnotationStatus;
  resolution: Resolution | null;
  replies?: Reply[];
}

/** Pseudo-path whose sidecar holds project-wide notes. */
export const PROJECT_PATH = "__project__";

export interface Sidecar {
  version: 1;
  /** the document this sidecar belongs to (authoritative — filenames flatten
   *  path separators and are not reversible) */
  docPath?: string;
  /** sha256 of the markdown source at the time position hints were last valid */
  docHash: string;
  annotations: Annotation[];
}

export interface TreeEntry {
  path: string; // relative to root, posix separators
  name: string;
  openComments: number;
}

export type ServerEvent =
  | { type: "doc:changed"; path: string; hash: string; source: "editor" | "external" }
  | { type: "comments:changed"; path: string };
