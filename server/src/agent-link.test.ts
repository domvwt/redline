import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeQuoteSelector, markdownToPlainText, type Sidecar } from "@redline/shared";
import {
  agentStatus,
  describeWait,
  rearmCommand,
  releaseWait,
  runWait,
  sendHandoff,
  stopListening,
  watchAgent,
} from "./agent-link.ts";
import { DocStore } from "./docs.ts";
import { EventHub } from "./events.ts";
import { buildApp } from "./routes.ts";
import { loadSidecar, saveSidecar } from "./sidecar.ts";

const DOC = "# Guide\n\nThe quick brown fox.\n";
const FAST = { timeoutMs: 2000, pollMs: 10 };
const SHORT = { timeoutMs: 50, pollMs: 10 };

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "redline-agent-test-"));
  await fs.writeFile(path.join(root, "guide.md"), DOC);
  const plain = markdownToPlainText(DOC);
  const start = plain.indexOf("quick brown");
  const sidecar: Sidecar = {
    version: 1,
    docHash: "",
    annotations: [
      {
        id: "c1",
        created: "2026-01-01T00:00:00Z",
        modified: "2026-01-01T00:00:00Z",
        body: { type: "TextualBody", value: "why a fox?" },
        target: {
          selector: [
            makeQuoteSelector(plain, start, start + 11),
            { type: "TextPositionSelector", start, end: start + 11 },
          ],
        },
        status: "open",
        resolution: null,
        replies: [{ by: "author", text: "still unclear", at: "2026-01-01T00:00:00Z" }],
      },
    ],
  };
  await saveSidecar(root, "guide.md", sidecar);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const readAgent = async () =>
  JSON.parse(await fs.readFile(path.join(root, ".redline", "agent.json"), "utf8"));
const writeAgent = (value: unknown) =>
  fs.writeFile(path.join(root, ".redline", "agent.json"), JSON.stringify(value));

/** a first wait woken by a send: the agent is now mid-pass */
async function startWorking() {
  const waiting = runWait(root, FAST);
  await expect.poll(() => agentStatus(root)).toMatchObject({ state: "listening" });
  await sendHandoff(root, "send");
  expect((await waiting).kind).toBe("sent");
}

async function resolveAll() {
  const sidecar = await loadSidecar(root, "guide.md");
  for (const a of sidecar.annotations) a.status = "resolved";
  await saveSidecar(root, "guide.md", sidecar);
}

describe("redline wait", () => {
  it("advertises listening while blocked, and wakes on a send", async () => {
    const waiting = runWait(root, FAST);
    await expect.poll(() => agentStatus(root)).toEqual({ state: "listening", pending: false, finished: false });
    await sendHandoff(root, "send");
    expect(await waiting).toEqual({ kind: "sent", open: 1, replies: 1 });
    expect(await agentStatus(root)).toEqual({ state: "working", pending: false, finished: false });
  });

  it("a re-arm returns at once for a send made while the agent was busy", async () => {
    await startWorking();
    await sendHandoff(root, "send");
    expect(await agentStatus(root)).toMatchObject({ pending: true });
    expect((await runWait(root, { ...FAST, resume: true })).kind).toBe("sent");
    // the same send never wakes it twice
    expect((await runWait(root, { ...SHORT, resume: true })).kind).toBe("timeout");
  });

  it("doesn't wake for a send with nothing open, and keeps listening", async () => {
    await resolveAll();
    const waiting = runWait(root, { timeoutMs: 200, pollMs: 10 });
    await expect.poll(() => agentStatus(root)).toMatchObject({ state: "listening" });
    await sendHandoff(root, "send");
    expect((await waiting).kind).toBe("timeout");
    expect(await agentStatus(root)).toMatchObject({ pending: false });
  });

  it("ends the loop on done", async () => {
    const waiting = runWait(root, FAST);
    await expect.poll(() => agentStatus(root)).toMatchObject({ state: "listening" });
    await sendHandoff(root, "done");
    expect(await waiting).toEqual({ kind: "done" });
    expect(await agentStatus(root)).toEqual({ state: "absent", pending: false, finished: true });
  });

  it("honours a done clicked mid-pass at the re-arm, and shows the loop ended", async () => {
    await startWorking();
    await sendHandoff(root, "done");
    expect(await agentStatus(root)).toEqual({ state: "absent", pending: false, finished: true });
    expect((await runWait(root, { ...FAST, resume: true })).kind).toBe("done");
  });

  it("runs a queued round before a done clicked after it", async () => {
    await startWorking();
    await sendHandoff(root, "send"); // queued
    await sendHandoff(root, "done");
    // the header shows the loop ended either way…
    expect(await agentStatus(root)).toEqual({ state: "absent", pending: false, finished: true });
    // …but a live agent still runs the queued round before stopping
    expect((await runWait(root, { ...FAST, resume: true })).kind).toBe("sent");
    expect((await runWait(root, { ...FAST, resume: true })).kind).toBe("done");
  });

  it("a new session's first wait treats every earlier click as covered", async () => {
    await startWorking(); // …then the agent never re-arms
    await sendHandoff(root, "send"); // a round nobody picked up
    await sendHandoff(root, "done");
    expect((await runWait(root, SHORT)).kind).toBe("timeout");
    await sendHandoff(root, "send"); // the old send didn't start a round…
    expect((await runWait(root, { ...SHORT, resume: true })).kind).toBe("sent"); // …a new one does
  });

  it("isn't 'finished' once a later session has listened and left", async () => {
    await startWorking();
    await sendHandoff(root, "done");
    expect((await runWait(root, { ...FAST, resume: true })).kind).toBe("done");
    expect((await agentStatus(root)).finished).toBe(true);
    // a new session listens, then times out
    expect((await runWait(root, SHORT)).kind).toBe("timeout");
    expect(await agentStatus(root)).toEqual({ state: "absent", pending: false, finished: false });
  });

  it("--stop clears a working header the agent walked away from", async () => {
    await startWorking();
    await sendHandoff(root, "send"); // queued, never picked up
    await stopListening(root);
    expect(await agentStatus(root)).toMatchObject({ state: "absent", finished: false });
  });

  it("--stop after the loop finished keeps 'review finished'", async () => {
    const waiting = runWait(root, FAST);
    await expect.poll(() => agentStatus(root)).toMatchObject({ state: "listening" });
    await sendHandoff(root, "done");
    await waiting;
    await stopListening(root);
    expect((await agentStatus(root)).finished).toBe(true);
  });

  it("--stop ends a wait still listening", async () => {
    const waiting = runWait(root, FAST);
    await expect.poll(() => agentStatus(root)).toMatchObject({ state: "listening" });
    await stopListening(root);
    expect((await waiting).kind).toBe("superseded");
    expect((await agentStatus(root)).state).toBe("absent");
  });

  it("times out without consuming anything, and stops advertising", async () => {
    expect((await runWait(root, SHORT)).kind).toBe("timeout");
    expect((await agentStatus(root)).state).toBe("absent");
  });

  it("yields to a newer wait so only one listener wakes per send", async () => {
    const first = runWait(root, FAST);
    await expect.poll(readAgent).toMatchObject({ state: "listening", pid: process.pid });
    const agent = await readAgent();
    // a second wait re-armed — same pid, as in a pid-namespaced sandbox
    await writeAgent({ ...agent, owner: "someone-else" });
    await sendHandoff(root, "send");
    expect((await first).kind).toBe("superseded");
  });

  it("reads a dead or silent listener as absent", async () => {
    const now = new Date().toISOString();
    await writeAgent({ state: "listening", pid: 2 ** 22 + 12345, consumed: 0, at: now });
    expect((await agentStatus(root)).state).toBe("absent");
    // our own pid is alive, but no heartbeat for minutes: pid reuse
    const old = new Date(Date.now() - 5 * 60_000).toISOString();
    await writeAgent({ state: "listening", pid: process.pid, consumed: 0, at: old });
    expect((await agentStatus(root)).state).toBe("absent");
  });

  it("keeps its heartbeat fresh while listening", async () => {
    const waiting = runWait(root, { timeoutMs: 300, pollMs: 10, heartbeatMs: 50 });
    await expect.poll(readAgent).toMatchObject({ state: "listening" });
    const first = (await readAgent()).at;
    await expect.poll(async () => (await readAgent()).at).not.toBe(first);
    await waiting;
  });

  it("release clears our own listening state", async () => {
    const waiting = runWait(root, { timeoutMs: 200, pollMs: 10 });
    await expect.poll(() => agentStatus(root)).toMatchObject({ state: "listening" });
    await releaseWait(root);
    expect((await agentStatus(root)).state).toBe("absent");
    await waiting;
  });
});

describe("wait output", () => {
  it("prints a re-arm command that survives the shell", () => {
    expect(rearmCommand("/srv/docs")).toBe("redline wait /srv/docs --resume");
    expect(rearmCommand("/home/me/My Docs", "30")).toBe("redline wait '/home/me/My Docs' --resume --timeout 30");
    expect(rearmCommand("/tmp/it's")).toBe(`redline wait '/tmp/it'\\''s' --resume`);
  });

  it("names the rearm command in sent and timeout lines only", () => {
    const rearm = "redline wait --resume";
    expect(describeWait({ kind: "sent", open: 2, replies: 1 }, rearm)).toContain(rearm);
    expect(describeWait({ kind: "timeout" }, rearm)).toContain(rearm);
    expect(describeWait({ kind: "done" }, rearm)).not.toContain(rearm);
  });
});

describe("watchAgent", () => {
  it("broadcasts when a listener appears and when it dies", async () => {
    const hub = new EventHub();
    const states: string[] = [];
    hub.subscribe((e) => {
      if (e.type === "agent:changed") states.push(e.status.state);
    });
    const stop = watchAgent(root, hub, 10);
    try {
      await expect.poll(() => states).toEqual(["absent"]);
      await writeAgent({ state: "listening", pid: process.pid, consumed: 0, at: new Date().toISOString() });
      await expect.poll(() => states).toEqual(["absent", "listening"]);
      await writeAgent({ state: "listening", pid: 2 ** 22 + 12345, consumed: 0, at: new Date().toISOString() });
      await expect.poll(() => states).toEqual(["absent", "listening", "absent"]);
    } finally {
      stop();
    }
  });
});

describe("sendHandoff", () => {
  it("serialises concurrent clicks: no lost seq, no temp-file collision", async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => sendHandoff(root, i % 2 ? "done" : "send")));
    const handoff = JSON.parse(await fs.readFile(path.join(root, ".redline", "handoff.json"), "utf8"));
    expect(handoff).toMatchObject({ seq: 20, action: "done", sendSeq: 19 });
  });
});

describe("handoff routes", () => {
  it("POST /api/handoff bumps the signal and broadcasts the status", async () => {
    const hub = new EventHub();
    const events: unknown[] = [];
    hub.subscribe((e) => events.push(e));
    const app = buildApp(new DocStore(root), hub);

    const res = await app.request("http://127.0.0.1/api/handoff", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "send" }),
    });
    expect(await res.json()).toEqual({ state: "absent", pending: true, finished: false });
    expect(events).toEqual([
      { type: "agent:changed", status: { state: "absent", pending: true, finished: false } },
    ]);

    const handoff = JSON.parse(await fs.readFile(path.join(root, ".redline", "handoff.json"), "utf8"));
    expect(handoff).toMatchObject({ seq: 1, action: "send" });

    const status = await app.request("http://127.0.0.1/api/agent");
    expect(await status.json()).toEqual({ state: "absent", pending: true, finished: false });

    const bad = await app.request("http://127.0.0.1/api/handoff", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "nope" }),
    });
    expect(bad.status).toBe(400);

    const malformed = await app.request("http://127.0.0.1/api/handoff", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(malformed.status).toBe(400);
  });
});

describe("redline wait CLI", () => {
  const bin = fileURLToPath(new URL("../../bin/redline.mjs", import.meta.url));
  const run = (...args: string[]) =>
    promisify(execFile)(process.execPath, [bin, "wait", ...args]).then(
      ({ stdout }) => ({ code: 0, out: stdout }),
      (err: { code: number; stderr: string }) => ({ code: err.code, out: err.stderr }),
    );

  it("refuses a folder redline doesn't serve", async () => {
    const bare = await fs.mkdtemp(path.join(os.tmpdir(), "redline-bare-"));
    try {
      expect(await run(bare)).toMatchObject({ code: 1, out: expect.stringContaining("no .redline/") });
    } finally {
      await fs.rm(bare, { recursive: true, force: true });
    }
  });

  it("rejects a missing or bad --timeout and unknown options", async () => {
    const results = await Promise.all([
      run(root, "--timeout"),
      run(root, "--timeout", "abc"),
      run(root, "--timeout", "Infinity"),
      run(root, "-h"),
      run(root, "--stop", "--resume"),
    ]);
    expect(results.map((r) => r.code)).toEqual([1, 1, 1, 1, 1]);
  });

  it("prints an absolute re-arm command that keeps the timeout", async () => {
    const { code, out } = await run(path.relative(process.cwd(), root), "--timeout", "0.001");
    expect(code).toBe(0);
    expect(out).toContain(rearmCommand(root, "0.001"));
  });

  it("--stop reports and clears", async () => {
    expect(await run(root, "--stop")).toEqual({ code: 0, out: "redline: stopped listening.\n" });
    expect((await agentStatus(root)).state).toBe("absent");
  });

  it("stops advertising when the task is killed", async () => {
    const child = spawn(process.execPath, [bin, "wait", root]);
    try {
      await expect.poll(() => agentStatus(root), { timeout: 10_000 }).toMatchObject({ state: "listening" });
      const exited = new Promise((r) => child.once("exit", r));
      child.kill("SIGTERM");
      await exited;
      expect((await agentStatus(root)).state).toBe("absent");
    } finally {
      child.kill("SIGKILL");
    }
  });
}, 30_000);
