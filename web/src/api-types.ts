import type { Annotation, ServerEvent, Sidecar, TreeEntry } from "@redline/shared";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface SearchResult {
  path: string;
  start: number;
  end: number;
  snippet: string;
}

export interface SelectorBody {
  quote: { exact: string; prefix: string; suffix: string };
  position: { start: number; end: number };
}

/** The full surface the app needs from a backend — served by the daemon over
 *  HTTP, or by the in-browser IndexedDB store in the static build. */
export interface RedlineApi {
  tree(): Promise<TreeEntry[]>;
  getDoc(path: string): Promise<{ markdown: string; hash: string; changed: boolean }>;
  getBaseline(path: string): Promise<{ markdown: string | null }>;
  markReviewed(path: string): Promise<{ ok: true }>;
  search(q: string): Promise<SearchResult[]>;
  putDoc(body: {
    path: string;
    markdown: string;
    baseHash: string;
    anchors?: Array<{ id: string; start: number; end: number }>;
  }): Promise<{ hash: string }>;
  importDoc(body: { name: string; markdown: string }): Promise<{ path: string }>;
  getComments(path: string): Promise<Sidecar>;
  createComment(body: {
    path: string;
    body: string;
    baseHash?: string;
    selector?: SelectorBody;
  }): Promise<Annotation>;
  patchComment(
    id: string,
    body: {
      path: string;
      body?: string;
      status?: "open" | "resolved";
      reply?: string;
      editReply?: { index: number; text: string };
      selector?: SelectorBody;
    },
  ): Promise<Annotation>;
  deleteComment(id: string, path: string): Promise<{ ok: true }>;
  /** browser store only: remove a document, its comments, and its baseline */
  deleteDoc?(path: string): Promise<{ ok: true }>;
}

export type SubscribeEvents = (handlers: {
  onEvent: (event: ServerEvent) => void;
  onReconnect?: () => void;
}) => () => void;
