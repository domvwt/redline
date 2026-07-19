import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { listOpenComments, resolveComment } from "./comments-service.ts";
import { DocStore } from "./docs.ts";
import { EventHub } from "./events.ts";

export function buildMcpServer(docs: DocStore, hub: EventHub): McpServer {
  const server = new McpServer({ name: "redline", version: "0.1.0" });

  server.registerTool(
    "list_comments",
    {
      description:
        "List the user's actionable review comments on markdown documents. Comments with a quote are anchored to that passage (quotes come from the RENDERED text, so markdown markup like ** may interrupt them in the source). A null quote is an unanchored note: it applies to the whole document — or, when path is '__project__', to the whole project (e.g. requests for new documents or restructuring). status 'orphaned' means the quoted passage no longer exists in the document — the comment may already be moot, or may need applying to the rewritten text. Comments you already addressed are excluded while they await the author's verdict; one reappearing here with a thread means the author REJECTED your proposal — read their reply and engage with it, don't repeat yourself. Address comments like a thoughtful human editor: read the document, make the edit the comment asks for (or decline with a reason), and look across comments for shared themes before editing. After addressing a comment, call resolve_comment.",
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe("Restrict to one document (path relative to the redline root). Omit for all."),
      },
    },
    async ({ path }) => {
      const comments = await listOpenComments(docs, path);
      return { content: [{ type: "text", text: JSON.stringify(comments, null, 2) }] };
    },
  );

  server.registerTool(
    "resolve_comment",
    {
      description:
        "Record your proposed resolution after editing the document (action 'resolved'), or decline the comment with a reason (action 'declined'). The note is shown to the author in the review UI — say what you changed or why you declined. This does NOT close the comment: it moves to 'addressed', where the author accepts it (closing it) or rejects it with a reply (reopening it for you). Never present an addressed comment to the user as finally resolved.",
      inputSchema: {
        path: z
          .string()
          .describe("Document path the comment belongs to ('__project__' for project notes)"),
        id: z.string().describe("Comment id from list_comments"),
        action: z.enum(["resolved", "declined"]),
        note: z.string().describe("What you changed, or why you declined"),
      },
    },
    async ({ path, id, action, note }) => {
      const annotation = await resolveComment(docs, hub, { path, id, action, note });
      return {
        content: [{ type: "text", text: `${id} -> ${annotation.status} (${action}): ${note}` }],
      };
    },
  );

  return server;
}

/**
 * Stdio MCP server, spawned on demand by Claude Code (`redline mcp [dir]`).
 * Works directly on the docs root and sidecar files — no daemon required.
 * If a daemon IS running, its file watcher picks up the sidecar writes and
 * pushes them to the browser, so the review UI still updates live.
 * Register once with:
 *   claude mcp add --scope user redline -- redline mcp
 */
export async function runStdioMcp(root: string): Promise<void> {
  const docs = new DocStore(root);
  // No SSE subscribers in this process — the daemon's watcher, not this hub,
  // is what notifies the browser.
  const server = buildMcpServer(docs, new EventHub());
  await server.connect(new StdioServerTransport());
}
