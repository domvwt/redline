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

/** backdate a signal file, as if it had been written `ms` ago */
async function backdate(name: "agent.json" | "handoff.json", ms: number) {
  const file = path.join(root, ".redline", name);
  const value = JSON.parse(await fs.readFile(file, "utf8"));
  await fs.writeFile(file, JSON.stringify({ ...value, at: new Date(Date.now() - ms).toISOString() }));
}

/** "Stop waiting": a second Done once the first has been outstanding a while */
async function stopWaiting() {
  await backdate("handoff.json", 60_000);
  await sendHandoff(root, "done");
}

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
    await expect.poll(() => agentStatus(root)).toEqual({
      state: "listening",
      pending: false,
      stopping: false,
      finished: false,
      round: null,
      rounds: 1,
      session: expect.any(String),
    });
    await sendHandoff(root, "send");
    expect(await waiting).toEqual({ kind: "sent", open: 1, replies: 1 });
    expect(await agentStatus(root)).toEqual({
      state: "working",
      pending: false,
      stopping: false,
      finished: false,
      round: { total: 1, answered: 0, held: ["c1"] },
      rounds: 2,
      session: expect.any(String),
    });
  });

  it("reports the round's progress as its comments stop being open", async () => {
    await startWorking();
    await resolveAll();
    expect((await agentStatus(root)).round).toEqual({ total: 1, answered: 1, held: [] });
    // a re-arm keeps the session's round count, and listening shows no progress
    const waiting = runWait(root, { ...FAST, resume: true });
    await expect.poll(() => agentStatus(root)).toMatchObject({ state: "listening", round: null, rounds: 2 });
    await sendHandoff(root, "done");
    expect((await waiting).kind).toBe("done");
    expect(await agentStatus(root)).toMatchObject({ finished: true, rounds: 2 });
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
    expect(await agentStatus(root)).toMatchObject({ state: "absent", pending: false, finished: true });
  });

  it("honours a done clicked mid-pass at the re-arm, and shows the loop ended", async () => {
    await startWorking();
    await sendHandoff(root, "done");
    // still finishing its pass: "stopping", not yet "finished"
    expect(await agentStatus(root)).toMatchObject({ state: "working", stopping: true, finished: false });
    expect((await runWait(root, { ...FAST, resume: true })).kind).toBe("done");
    expect(await agentStatus(root)).toMatchObject({ state: "absent", stopping: false, finished: true });
  });

  it("runs a queued round before a done clicked after it", async () => {
    await startWorking();
    await sendHandoff(root, "send"); // queued
    await sendHandoff(root, "done");
    // the bar shows the agent stopping, with the queued round still to come…
    expect(await agentStatus(root)).toMatchObject({ state: "working", pending: true, stopping: true });
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
    // a new session listens, then times out — and never re-arms
    expect((await runWait(root, SHORT)).kind).toBe("timeout");
    await backdate("agent.json", 120_000);
    expect(await agentStatus(root)).toMatchObject({ state: "absent", pending: false, finished: false });
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

  it("times out without consuming anything; reads as listening while the agent re-arms, then stops", async () => {
    expect((await runWait(root, SHORT)).kind).toBe("timeout");
    expect((await agentStatus(root)).state).toBe("listening");
    // a send in the gap waits for the re-arm, which picks it up
    await sendHandoff(root, "send");
    expect(await agentStatus(root)).toMatchObject({ state: "listening", pending: true });
    expect((await runWait(root, { ...FAST, resume: true })).kind).toBe("sent");
  });

  it("a timed-out wait nobody re-arms stops advertising after the grace period", async () => {
    expect((await runWait(root, SHORT)).kind).toBe("timeout");
    await backdate("agent.json", 120_000);
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
    expect(await res.json()).toMatchObject({ state: "absent", pending: true, finished: false });
    expect(events).toEqual([
      {
        type: "agent:changed",
        status: { state: "absent", pending: true, stopping: false, finished: false, round: null, rounds: 0, session: null },
      },
    ]);

    const handoff = JSON.parse(await fs.readFile(path.join(root, ".redline", "handoff.json"), "utf8"));
    expect(handoff).toMatchObject({ seq: 1, action: "send" });

    const status = await app.request("http://127.0.0.1/api/agent");
    expect(await status.json()).toMatchObject({ state: "absent", pending: true, finished: false });

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

describe("round bookkeeping", () => {
  it("a reply to a proposal mid-round is next round's work, not this one's", async () => {
    await startWorking(); // c1's earlier author reply predates the round, so it's held
    expect((await agentStatus(root)).round).toEqual({ total: 1, answered: 0, held: ["c1"] });
    const sidecar = await loadSidecar(root, "guide.md");
    const replies = sidecar.annotations[0].replies!;
    // a follow-up on a comment the agent hasn't reached yet stays with the agent
    replies.push({ by: "author", text: "and the dog?", at: new Date(Date.now() + 1000).toISOString() });
    await saveSidecar(root, "guide.md", sidecar);
    expect((await agentStatus(root)).round).toEqual({ total: 1, answered: 0, held: ["c1"] });
    // the agent proposes (folded into the thread on rejection), then the author replies
    replies.push({ by: "claude", text: "made it a cat", at: new Date(Date.now() + 2000).toISOString(), action: "resolved" });
    replies.push({ by: "author", text: "no, try again", at: new Date(Date.now() + 3000).toISOString() });
    await saveSidecar(root, "guide.md", sidecar);
    expect((await agentStatus(root)).round).toEqual({ total: 1, answered: 1, held: [] });
  });

  it("a quick second Done (double click, second tab) doesn't give up on the agent", async () => {
    await startWorking();
    await sendHandoff(root, "done");
    await sendHandoff(root, "done");
    expect(await agentStatus(root)).toMatchObject({ state: "working", stopping: true, finished: false });
  });

  it("keeps one session id across a session's re-arms, and a new one per session", async () => {
    await startWorking();
    const first = (await agentStatus(root)).session;
    expect(first).toEqual(expect.any(String));
    const waiting = runWait(root, { ...FAST, resume: true });
    await expect.poll(() => agentStatus(root)).toMatchObject({ state: "listening", session: first });
    await stopListening(root);
    await waiting;
    expect((await agentStatus(root)).session).toBe(first);
    const next = runWait(root, FAST);
    await expect.poll(() => agentStatus(root)).toMatchObject({ state: "listening" });
    expect((await agentStatus(root)).session).not.toBe(first);
    await stopListening(root);
    await next;
  });

  it("a second Done while stopping gives up on an agent that died mid-pass", async () => {
    await startWorking(); // …and the agent's session then dies
    await sendHandoff(root, "done");
    expect(await agentStatus(root)).toMatchObject({ state: "working", stopping: true });
    await stopWaiting();
    expect(await agentStatus(root)).toMatchObject({ state: "absent", stopping: false, finished: true });
    // a live agent's re-arm still ends on it
    expect((await runWait(root, { ...FAST, resume: true })).kind).toBe("done");
  });

  it("an accepted proposal reopened mid-round stays answered", async () => {
    await startWorking();
    const sidecar = await loadSidecar(root, "guide.md");
    // the agent's proposal, folded into the thread when the author reopened it
    sidecar.annotations[0].replies!.push({
      by: "claude",
      text: "made it a cat",
      at: new Date(Date.now() + 1000).toISOString(),
      action: "resolved",
    });
    await saveSidecar(root, "guide.md", sidecar);
    expect((await agentStatus(root)).round).toEqual({ total: 1, answered: 1, held: [] });
  });

  it("--stop doesn't turn a Done nobody's loop saw into 'stopped'", async () => {
    await sendHandoff(root, "send");
    await sendHandoff(root, "done");
    await stopListening(root);
    expect(await agentStatus(root)).toMatchObject({ finished: false });
  });

  it("--stop after a Done mid-pass reads as stopped, not as no agent", async () => {
    await startWorking();
    await sendHandoff(root, "done");
    await stopListening(root);
    expect(await agentStatus(root)).toMatchObject({ state: "absent", stopping: false, finished: true });
  });

  it("a done clears a long-stale working as finished, not stopping", async () => {
    await writeAgent({ state: "working", pid: null, consumed: 0, at: new Date(Date.now() - 3 * 3600_000).toISOString() });
    await sendHandoff(root, "done");
    expect(await agentStatus(root)).toMatchObject({ state: "absent", stopping: false, finished: true });
  });

  it("a done after a listener died isn't 'finished' — nothing ran to stop", async () => {
    await writeAgent({ state: "absent", pid: null, consumed: 0, at: new Date().toISOString() });
    await sendHandoff(root, "send");
    await sendHandoff(root, "done");
    expect(await agentStatus(root)).toMatchObject({ state: "absent", pending: false, finished: false });
  });

  it("a send with nothing open neither bumps rounds nor replaces the round", async () => {
    await startWorking(); // rounds 2, round [c1]
    await resolveAll();
    const waiting = runWait(root, { ...FAST, resume: true });
    await expect.poll(() => agentStatus(root)).toMatchObject({ state: "listening" });
    await sendHandoff(root, "send"); // nothing open: the wait keeps listening
    await expect.poll(async () => (await readAgent()).consumed).toBeGreaterThanOrEqual(2);
    expect(await readAgent()).toMatchObject({ state: "listening", round: [{ path: "guide.md", id: "c1" }], rounds: 2 });
    await sendHandoff(root, "done");
    expect((await waiting).kind).toBe("done");
    expect(await agentStatus(root)).toMatchObject({ finished: true, rounds: 2 });
  });

  it("a re-arm keeps the round, and the next send replaces it and counts", async () => {
    await startWorking(); // rounds 2
    const waiting = runWait(root, { ...FAST, resume: true });
    await expect.poll(() => agentStatus(root)).toMatchObject({ state: "listening", round: null, rounds: 2 });
    expect((await readAgent()).round).toEqual([{ path: "guide.md", id: "c1" }]);
    await sendHandoff(root, "send");
    expect((await waiting).kind).toBe("sent");
    expect(await agentStatus(root)).toMatchObject({ state: "working", round: { total: 1, answered: 0, held: ["c1"] }, rounds: 3 });
  });

  it("progress still shows while a next round is queued", async () => {
    await startWorking();
    await sendHandoff(root, "send"); // queued mid-pass
    expect(await agentStatus(root)).toMatchObject({
      state: "working",
      pending: true,
      round: { total: 1, answered: 0, held: ["c1"] },
    });
  });

  it("--stop, timeout and a killed wait keep the session's rounds", async () => {
    await startWorking(); // rounds 2
    await stopListening(root);
    expect(await readAgent()).toMatchObject({ state: "absent", round: [{ path: "guide.md", id: "c1" }], rounds: 2 });
    expect(await agentStatus(root)).toMatchObject({ rounds: 2, round: null });

    expect((await runWait(root, { ...SHORT, resume: true })).kind).toBe("timeout");
    expect(await readAgent()).toMatchObject({ state: "rearming", rounds: 2 });

    const waiting = runWait(root, { ...FAST, resume: true });
    await expect.poll(readAgent).toMatchObject({ state: "listening" });
    await releaseWait(root);
    expect(await readAgent()).toMatchObject({ state: "absent", rounds: 2, round: [{ path: "guide.md", id: "c1" }] });
    await stopListening(root);
    await waiting;
  });

  it("a new session's first wait starts the count again", async () => {
    await startWorking(); // rounds 2
    await sendHandoff(root, "done");
    expect((await runWait(root, { ...FAST, resume: true })).kind).toBe("done");
    const waiting = runWait(root, FAST); // a new session
    await expect.poll(() => agentStatus(root)).toMatchObject({ state: "listening", rounds: 1 });
    expect((await readAgent()).round).toBeUndefined();
    await stopListening(root);
    await waiting;
  });
});

describe("Done mid-pass (validation)", () => {
  async function addComment(id: string) {
    const sidecar = await loadSidecar(root, "guide.md");
    sidecar.annotations.push({ ...sidecar.annotations[0], id, status: "open", resolution: null, replies: [] });
    await saveSidecar(root, "guide.md", sidecar);
  }

  it("a Done after a queued round stays 'stopping' through that round, then finishes", async () => {
    await startWorking(); // rounds 2, round [c1]
    await resolveAll(); // agent answered c1
    await addComment("c2"); // new work while it was busy
    await sendHandoff(root, "send"); // Queue
    await sendHandoff(root, "done"); // Done for now
    expect(await agentStatus(root)).toMatchObject({ state: "working", stopping: true, finished: false });

    // the agent re-arms: the queued round runs, and the bar still reads "stopping"
    expect((await runWait(root, { ...FAST, resume: true })).kind).toBe("sent");
    expect(await agentStatus(root)).toMatchObject({
      state: "working",
      pending: false,
      stopping: true,
      finished: false,
      round: { total: 1, answered: 0, held: ["c2"] },
      rounds: 3,
    });

    // its next re-arm honours the Done
    expect((await runWait(root, { ...FAST, resume: true })).kind).toBe("done");
    expect(await agentStatus(root)).toMatchObject({
      state: "absent",
      pending: false,
      stopping: false,
      finished: true,
      round: null,
      rounds: 3,
    });
  });

  it("--stop while stopping clears 'stopping'", async () => {
    await startWorking();
    await sendHandoff(root, "done");
    expect(await agentStatus(root)).toMatchObject({ stopping: true });
    await stopListening(root);
    expect(await agentStatus(root)).toMatchObject({ state: "absent", stopping: false, round: null });
  });

  it("a new session after a Done-then-stop starts clean", async () => {
    await startWorking();
    await sendHandoff(root, "done");
    await stopListening(root);
    const waiting = runWait(root, FAST); // new session's first wait: the old Done is moot
    await expect.poll(() => agentStatus(root)).toMatchObject({
      state: "listening",
      stopping: false,
      finished: false,
      rounds: 1,
    });
    await sendHandoff(root, "send");
    expect((await waiting).kind).toBe("sent");
  });
});

describe("edge flows (validation, iteration 3)", () => {
  async function addComment(id: string, relPath = "guide.md", status: "open" | "orphaned" = "open") {
    const sidecar = await loadSidecar(root, "guide.md");
    const template = sidecar.annotations[0];
    const target = relPath === "guide.md" ? sidecar : await loadSidecar(root, relPath);
    target.annotations.push({
      ...template,
      id,
      status,
      resolution: null,
      replies: [],
      target: relPath === "guide.md" ? template.target : null,
    });
    await saveSidecar(root, relPath, target);
  }

  it("--stop with a queued round and no Done leaves the send waiting for an agent", async () => {
    await startWorking();
    await sendHandoff(root, "send"); // queued, never picked up
    await stopListening(root);
    // the bar reads "Nobody listening", not "No agent" or "Agent stopped"
    expect(await agentStatus(root)).toMatchObject({ state: "absent", pending: true, finished: false });
  });

  it("an abandoned pass with a queued round reads as waiting for an agent, not finished", async () => {
    await startWorking();
    await sendHandoff(root, "send");
    const agent = await readAgent();
    await writeAgent({ ...agent, at: new Date(Date.now() - 3 * 3600_000).toISOString() });
    expect(await agentStatus(root)).toMatchObject({
      state: "absent",
      pending: true,
      stopping: false,
      finished: false,
      round: null,
    });
  });

  it("a Done behind a queued round with nothing left open still ends at the re-arm", async () => {
    await startWorking();
    await sendHandoff(root, "send"); // queued…
    await sendHandoff(root, "done");
    await resolveAll(); // …but the agent answered everything before re-arming
    expect((await runWait(root, { ...FAST, resume: true })).kind).toBe("done");
    expect(await agentStatus(root)).toMatchObject({ state: "absent", pending: false, finished: true, rounds: 2 });
  });

  it("round progress: a deleted comment is answered, an orphaned one is still held, project notes count", async () => {
    await addComment("c2", "guide.md", "orphaned");
    await addComment("p1", "__project__");
    await startWorking();
    expect((await agentStatus(root)).round).toMatchObject({ total: 3, answered: 0 });
    const sidecar = await loadSidecar(root, "guide.md");
    sidecar.annotations = sidecar.annotations.filter((a) => a.id !== "c1"); // author deleted it
    await saveSidecar(root, "guide.md", sidecar);
    const project = await loadSidecar(root, "__project__");
    project.annotations[0].status = "addressed";
    await saveSidecar(root, "__project__", project);
    expect((await agentStatus(root)).round).toEqual({ total: 3, answered: 2, held: ["c2"] });
  });

  it("release leaves a newer wait's listening state alone", async () => {
    const first = runWait(root, { timeoutMs: 300, pollMs: 10 });
    await expect.poll(() => agentStatus(root)).toMatchObject({ state: "listening" });
    const second = runWait(root, { timeoutMs: 300, pollMs: 10 }); // re-arm: takes ownership
    expect((await first).kind).toBe("superseded");
    await expect.poll(readAgent).toMatchObject({ state: "listening" });
    // a signal to the *older* process: activeOwner is module-level, so in one
    // process it's the newer owner — simulate the older one by a foreign owner
    const agent = await readAgent();
    await writeAgent({ ...agent, owner: "newer-wait-elsewhere" });
    await releaseWait(root);
    expect((await readAgent()).state).toBe("listening");
    await second;
  });
});

describe("forced Done (validation, iteration 4)", () => {
  const readHandoff = async () =>
    JSON.parse(await fs.readFile(path.join(root, ".redline", "handoff.json"), "utf8"));
  async function addComment(id: string) {
    const sidecar = await loadSidecar(root, "guide.md");
    sidecar.annotations.push({ ...sidecar.annotations[0], id, status: "open", resolution: null, replies: [] });
    await saveSidecar(root, "guide.md", sidecar);
  }

  it("a new session after a forced Done listens, and its first Send wakes it", async () => {
    await startWorking();
    await sendHandoff(root, "done");
    await stopWaiting(); // Stop waiting
    expect((await readHandoff()).force).toBe(true);
    expect(await agentStatus(root)).toMatchObject({ state: "absent", finished: true });

    const waiting = runWait(root, FAST); // new session's first wait
    await expect.poll(() => agentStatus(root)).toMatchObject({
      state: "listening",
      pending: false,
      stopping: false,
      finished: false,
      rounds: 1,
    });
    await sendHandoff(root, "send");
    expect((await readHandoff()).force).toBeUndefined();
    expect((await waiting).kind).toBe("sent");
    expect(await agentStatus(root)).toMatchObject({ state: "working", stopping: false, finished: false });
  });

  it("only a Done still outstanding on a working agent forces", async () => {
    // a Done the re-arm already honoured (a stale tab's second click)
    await startWorking();
    await sendHandoff(root, "done");
    expect((await runWait(root, { ...FAST, resume: true })).kind).toBe("done");
    await sendHandoff(root, "done");
    expect((await readHandoff()).force).toBeUndefined();
    expect(await agentStatus(root)).toMatchObject({ state: "absent", finished: true });

    // two Dones with nothing working: nothing to give up on
    await writeAgent({ state: "absent", pid: null, consumed: (await readHandoff()).seq, at: new Date().toISOString() });
    await sendHandoff(root, "done");
    await stopWaiting();
    expect((await readHandoff()).force).toBeUndefined();
    expect(await agentStatus(root)).toMatchObject({ state: "absent", finished: false });
  });

  it("--stop after a forced Done keeps 'stopped'", async () => {
    await startWorking();
    await sendHandoff(root, "done");
    await stopWaiting();
    await stopListening(root);
    expect(await agentStatus(root)).toMatchObject({ state: "absent", pending: false, finished: true });
    expect((await readAgent()).state).toBe("finished");
  });

  // "Stop waiting" on an agent that was in fact alive, with a round queued
  // before the Done: the bar already reads "Agent stopped", so the re-arm
  // drops that round rather than run it unseen
  it("forced Done with a queued round: a live agent's re-arm doesn't run it behind 'Agent stopped'", async () => {
    await startWorking();
    await resolveAll();
    await addComment("c2");
    await sendHandoff(root, "send"); // Queue
    await sendHandoff(root, "done"); // Done for now -> "Then one more round"
    await stopWaiting(); // Stop waiting, but the agent was alive
    expect(await agentStatus(root)).toMatchObject({ state: "absent", pending: false, finished: true });
    expect((await runWait(root, { ...FAST, resume: true })).kind).toBe("done");
  });

  it("forced Done with a queued round: after the re-arm ends, nothing reads as pending or working", async () => {
    await startWorking();
    await addComment("c2");
    await sendHandoff(root, "send"); // Queue
    await sendHandoff(root, "done");
    await stopWaiting(); // Stop waiting
    expect((await runWait(root, { ...FAST, resume: true })).kind).toBe("done");
    expect(await agentStatus(root)).toMatchObject({
      state: "absent",
      pending: false,
      stopping: false,
      finished: true,
      round: null,
      rounds: 2,
    });
    expect((await readAgent()).consumed).toBe((await readHandoff()).seq);
    // the dropped round doesn't wake a new session's first wait; its own Send does
    const waiting = runWait(root, FAST);
    await expect.poll(() => agentStatus(root)).toMatchObject({ state: "listening", pending: false, finished: false });
    await sendHandoff(root, "send");
    expect((await waiting).kind).toBe("sent");
    expect((await agentStatus(root)).round).toMatchObject({ total: 2, answered: 0 });
  });

  it("forced Done with a queued round: a live agent's --stop keeps 'stopped', not 'nobody listening'", async () => {
    await startWorking();
    await sendHandoff(root, "send"); // Queue
    await sendHandoff(root, "done");
    await stopWaiting(); // Stop waiting
    await stopListening(root);
    expect(await agentStatus(root)).toMatchObject({ state: "absent", pending: false, stopping: false, finished: true });
  });

  it("a plain Done behind a queued round is not forced: the re-arm runs the round, then ends", async () => {
    await startWorking();
    await addComment("c2");
    await sendHandoff(root, "send"); // Queue
    await sendHandoff(root, "done"); // Done for now, once
    expect((await readHandoff()).force).toBeUndefined();
    expect((await runWait(root, { ...FAST, resume: true })).kind).toBe("sent");
    expect(await agentStatus(root)).toMatchObject({ state: "working", stopping: true, pending: false });
    // Stop waiting now (second Done while stopping) forces; the next re-arm still just ends
    await stopWaiting();
    expect((await readHandoff()).force).toBe(true);
    expect(await agentStatus(root)).toMatchObject({ state: "absent", finished: true, pending: false });
    expect((await runWait(root, { ...FAST, resume: true })).kind).toBe("done");
  });
});
