import type { Annotation, ServerEvent, Sidecar, TreeEntry } from "@redline/shared";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError((body as { error?: string }).error ?? res.statusText, res.status);
  }
  return res.json() as Promise<T>;
}

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

export const api = {
  tree: () => fetch("/api/tree").then((r) => json<TreeEntry[]>(r)),

  getDoc: (path: string) =>
    fetch(`/api/doc?path=${encodeURIComponent(path)}`).then((r) =>
      json<{ markdown: string; hash: string; changed: boolean }>(r),
    ),

  getBaseline: (path: string) =>
    fetch(`/api/baseline?path=${encodeURIComponent(path)}`).then((r) =>
      json<{ markdown: string | null }>(r),
    ),

  markReviewed: (path: string) =>
    fetch("/api/reviewed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path }),
    }).then((r) => json<{ ok: true }>(r)),

  search: (q: string) =>
    fetch(`/api/search?q=${encodeURIComponent(q)}`).then((r) => json<SearchResult[]>(r)),

  putDoc: (body: {
    path: string;
    markdown: string;
    baseHash: string;
    anchors?: Array<{ id: string; start: number; end: number }>;
  }) =>
    fetch("/api/doc", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => json<{ hash: string }>(r)),

  importDoc: (body: { name: string; markdown: string }) =>
    fetch("/api/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => json<{ path: string }>(r)),

  getComments: (path: string) =>
    fetch(`/api/comments?path=${encodeURIComponent(path)}`).then((r) => json<Sidecar>(r)),

  createComment: (body: {
    path: string;
    body: string;
    baseHash?: string;
    selector?: {
      quote: { exact: string; prefix: string; suffix: string };
      position: { start: number; end: number };
    };
  }) =>
    fetch("/api/comments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => json<Annotation>(r)),

  patchComment: (
    id: string,
    body: {
      path: string;
      body?: string;
      status?: "open" | "resolved";
      reply?: string;
      editReply?: { index: number; text: string };
      selector?: {
        quote: { exact: string; prefix: string; suffix: string };
        position: { start: number; end: number };
      };
    },
  ) =>
    fetch(`/api/comments/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => json<Annotation>(r)),

  deleteComment: (id: string, path: string) =>
    fetch(`/api/comments/${id}?path=${encodeURIComponent(path)}`, { method: "DELETE" }).then((r) =>
      json<{ ok: true }>(r),
    ),
};

export function subscribeEvents(handlers: {
  onEvent: (event: ServerEvent) => void;
  onReconnect?: () => void;
}): () => void {
  const source = new EventSource("/api/events");
  let hadFirstOpen = false;
  source.onopen = () => {
    if (hadFirstOpen) handlers.onReconnect?.();
    hadFirstOpen = true;
  };
  source.onmessage = (msg) => {
    if (!msg.data) return;
    try {
      handlers.onEvent(JSON.parse(msg.data) as ServerEvent);
    } catch {
      // ignore malformed events
    }
  };
  return () => source.close();
}
