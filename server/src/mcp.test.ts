import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { markdownToPlainText, makeQuoteSelector, type Sidecar } from "@redline/shared";
import { DocStore } from "./docs.ts";
import { EventHub } from "./events.ts";
import { buildMcpServer } from "./mcp.ts";
import { loadSidecar, saveSidecar } from "./sidecar.ts";

const DOC = `# Guide

The quick brown fox jumps over the lazy dog.
`;

let root: string;
let client: Client;

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content.map((c) => c.text ?? "").join("");
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "redline-mcp-test-"));
  await fs.writeFile(path.join(root, "guide.md"), DOC);

  const plain = markdownToPlainText(DOC);
  const start = plain.indexOf("quick brown fox");
  const sidecar: Sidecar = await loadSidecar(root, "guide.md");
  sidecar.annotations.push({
    id: "c1",
    created: "2026-01-01T00:00:00Z",
    modified: "2026-01-01T00:00:00Z",
    body: { type: "TextualBody", value: "why a fox?" },
    target: {
      selector: [
        makeQuoteSelector(plain, start, start + 15),
        { type: "TextPositionSelector", start, end: start + 15 },
      ],
    },
    status: "open",
    resolution: null,
  });
  await saveSidecar(root, "guide.md", sidecar);

  // the same wiring `redline mcp` uses, minus the stdio transport
  const server = buildMcpServer(new DocStore(root), new EventHub());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
});

afterEach(async () => {
  await client.close();
  await fs.rm(root, { recursive: true, force: true });
});

describe("stdio MCP surface", () => {
  it("list_comments returns open comments straight from the sidecar files", async () => {
    const result = await client.callTool({ name: "list_comments", arguments: {} });
    const comments = JSON.parse(textOf(result)) as Array<{ id: string; quote: string | null }>;
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      id: "c1",
      path: "guide.md",
      quote: "quick brown fox",
      comment: "why a fox?",
    });
  });

  it("resolve_comment records a proposal (addressed) awaiting the author", async () => {
    await client.callTool({
      name: "resolve_comment",
      arguments: { path: "guide.md", id: "c1", action: "resolved", note: "kept the fox" },
    });
    const sidecar = await loadSidecar(root, "guide.md");
    expect(sidecar.annotations[0].status).toBe("addressed");
    expect(sidecar.annotations[0].resolution).toEqual({ action: "resolved", note: "kept the fox" });

    // pending proposals drop out of the listing until the author's verdict
    const result = await client.callTool({ name: "list_comments", arguments: {} });
    expect(JSON.parse(textOf(result))).toHaveLength(0);
  });

  it("resolve_comment rejects path traversal", async () => {
    const result = await client.callTool({
      name: "resolve_comment",
      arguments: { path: "../evil.md", id: "c1", action: "resolved", note: "x" },
    });
    expect(result.isError).toBe(true);
  });
});
