import * as browser from "./api-browser.ts";
import * as daemon from "./api-daemon.ts";

export { ApiError, type SearchResult } from "./api-types.ts";

/** Static build: no daemon, documents and comments live in the browser and
 *  the agent leg is the copy/paste handoff. Vite inlines the env var, so the
 *  unused backend is dead code. */
export const STATIC_MODE = import.meta.env.VITE_REDLINE_STATIC === "1";

export const api = STATIC_MODE ? browser.api : daemon.api;
export const subscribeEvents = STATIC_MODE ? browser.subscribeEvents : daemon.subscribeEvents;
