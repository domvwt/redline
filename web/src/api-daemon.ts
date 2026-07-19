import type { ServerEvent } from "@redline/shared";
import { ApiError, type RedlineApi, type SubscribeEvents } from "./api-types.ts";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError((body as { error?: string }).error ?? res.statusText, res.status);
  }
  return res.json() as Promise<T>;
}

export const api: RedlineApi = {
  tree: () => fetch("/api/tree").then((r) => json(r)),

  getDoc: (path) => fetch(`/api/doc?path=${encodeURIComponent(path)}`).then((r) => json(r)),

  getBaseline: (path) =>
    fetch(`/api/baseline?path=${encodeURIComponent(path)}`).then((r) => json(r)),

  markReviewed: (path) =>
    fetch("/api/reviewed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path }),
    }).then((r) => json(r)),

  search: (q) => fetch(`/api/search?q=${encodeURIComponent(q)}`).then((r) => json(r)),

  putDoc: (body) =>
    fetch("/api/doc", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => json(r)),

  importDoc: (body) =>
    fetch("/api/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => json(r)),

  getComments: (path) =>
    fetch(`/api/comments?path=${encodeURIComponent(path)}`).then((r) => json(r)),

  createComment: (body) =>
    fetch("/api/comments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => json(r)),

  patchComment: (id, body) =>
    fetch(`/api/comments/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => json(r)),

  deleteComment: (id, path) =>
    fetch(`/api/comments/${id}?path=${encodeURIComponent(path)}`, { method: "DELETE" }).then((r) =>
      json(r),
    ),
};

export const subscribeEvents: SubscribeEvents = (handlers) => {
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
};
