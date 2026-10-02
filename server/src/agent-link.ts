import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentStatus, Annotation } from "@redline/shared";
import { listOpenComments } from "./comments-service.ts";
import { DocStore } from "./docs.ts";
import { EventHub } from "./events.ts";
import { atomicWrite, loadSidecar } from "./sidecar.ts";

/**
 * The "send to agent" link, on the filesystem like everything else: the
 * daemon writes handoff.json when the author clicks Send/Done; an agent
 * blocked in `redline wait` writes agent.json. The two never talk directly.
 */

interface HandoffFile {
  /** bumped on every click */
  seq: number;
  action: "send" | "done";
  /** seq of the latest send, so a Done clicked after a queued send can't swallow it */
  sendSeq?: number;
  /** a second Done while the agent was still "stopping": it isn't coming back */
  force?: boolean;
  at: string;
}

interface AgentFile {
  /** finished: a wait ended the loop on the author's Done; rearming: a
   *  wait timed out and the agent is about to start the next */
  state: "listening" | "working" | "absent" | "finished" | "rearming";
  /** liveness only — pids can collide across sandboxes, so ownership uses `owner` */
  pid: number | null;
  /** the wait that last claimed the file */
  owner?: string;
  /** handoff seq the agent has caught up to */
  consumed: number;
  /** refreshed every HEARTBEAT_MS while listening */
  at: string;
  /** the comments the latest send handed over */
  round?: { path: string; id: string }[];
  /** when that send woke the agent */
  roundAt?: string;
  /** rounds this session has run, its first full pass included */
  rounds?: number;
  /** set by a session's first wait, carried by its re-arms */
  session?: string;
}

const HEARTBEAT_MS = 30_000;
/** a listener this quiet is gone, even if its pid was since reused */
const LISTENING_STALE_MS = 3 * HEARTBEAT_MS;
/** a pass that outlives this is assumed abandoned (agent killed mid-work) */
const WORKING_STALE_MS = 2 * 60 * 60 * 1000;
/** how long a timed-out wait still reads as listening while the agent re-arms */
const REARM_GRACE_MS = 60_000;
/** a second Done this long after the first means the agent isn't coming back;
 *  sooner, it's a double click or a second tab */
const FORCE_AFTER_MS = 10_000;

const handoffFile = (root: string) => path.join(root, ".redline", "handoff.json");
const agentFile = (root: string) => path.join(root, ".redline", "agent.json");

const sendSeqOf = (h: HandoffFile | null): number =>
  h?.sendSeq ?? (h?.action === "send" ? h.seq : 0);

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return null; // missing, or torn by a hand edit — treat as never written
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await atomicWrite(file, JSON.stringify(value, null, 2) + "\n");
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"; // exists, not ours
  }
}

/** What the browser's agent bar shows: is an agent waiting, working, or gone? */
export async function agentStatus(root: string): Promise<AgentStatus> {
  const [handoff, agent] = await Promise.all([
    readJson<HandoffFile>(handoffFile(root)),
    readJson<AgentFile>(agentFile(root)),
  ]);
  const consumed = agent?.consumed ?? 0;
  const stopped = handoff?.action === "done" && handoff.seq > consumed;
  const age = agent ? Date.now() - Date.parse(agent.at) : Infinity;
  let state: AgentStatus["state"] = "absent";
  if (
    (agent?.state === "listening" && agent.pid !== null && age < LISTENING_STALE_MS && isAlive(agent.pid)) ||
    (agent?.state === "rearming" && age < REARM_GRACE_MS)
  ) {
    state = "listening";
  } else if (agent?.state === "working" && age < WORKING_STALE_MS && !(stopped && handoff?.force)) {
    state = "working";
  }
  // a Done mid-pass lets the agent finish its pass (and any queued round) first
  const stopping = state === "working" && stopped;
  // a working agent still runs a round queued before the Done
  const pending = sendSeqOf(handoff) > consumed && (!stopped || state === "working");
  // a stale "working" the Done cleared also ended the loop; a session that
  // listened after the Done (and then left) didn't
  const finished =
    state === "absent" && (agent?.state === "finished" || (stopped && agent?.state === "working"));
  return {
    state,
    pending,
    stopping,
    finished,
    round: state === "working" ? await roundProgress(root, agent!) : null,
    rounds: agent?.rounds ?? 0,
    session: agent?.session ?? null,
  };
}

/**
 * How far the agent is through the round it was handed. Reads only the
 * round's own sidecars: the daemon asks every second while it works.
 */
async function roundProgress(root: string, agent: AgentFile): Promise<AgentStatus["round"]> {
  const round = agent.round;
  if (!round?.length) return null;
  const since = agent.roundAt ? Date.parse(agent.roundAt) : Infinity;
  try {
    const annotations = new Map<string, Annotation[]>();
    for (const p of new Set(round.map((c) => c.path))) {
      annotations.set(p, (await loadSidecar(root, p)).annotations);
    }
    const held = round
      .filter(({ path: p, id }) => {
        const a = annotations.get(p)?.find((x) => x.id === id);
        if (!a || (a.status !== "open" && a.status !== "orphaned")) return false; // answered, or gone
        // reopened after the agent proposed this round (a reply, or a reopen
        // of an accepted proposal): answered — anything new is next round's
        return !(a.replies ?? []).some((r) => r.by !== "author" && Date.parse(r.at) > since);
      })
      .map((c) => c.id);
    return { total: round.length, answered: round.length - held.length, held };
  } catch {
    return null;
  }
}

// serialised: two tabs clicking at once would otherwise lose a seq bump
let handoffChain: Promise<unknown> = Promise.resolve();

/** Author clicked Send (or Done): wake whichever `redline wait` is listening. */
export function sendHandoff(root: string, action: HandoffFile["action"]): Promise<void> {
  const next = handoffChain.then(async () => {
    const [current, agent] = await Promise.all([
      readJson<HandoffFile>(handoffFile(root)),
      readJson<AgentFile>(agentFile(root)),
    ]);
    const seq = (current?.seq ?? 0) + 1;
    // Done again while still waiting on the first: the agent died mid-pass
    const force =
      action === "done" &&
      current?.action === "done" &&
      current.seq > (agent?.consumed ?? 0) &&
      agent?.state === "working" &&
      Date.now() - Date.parse(current.at) >= FORCE_AFTER_MS;
    await writeJson(handoffFile(root), {
      seq,
      action,
      sendSeq: action === "send" ? seq : sendSeqOf(current),
      ...(force ? { force } : {}),
      at: new Date().toISOString(),
    } satisfies HandoffFile);
  });
  handoffChain = next.catch(() => {});
  return next;
}

/**
 * Push agent status changes to the browser. Polled rather than watched: an
 * agent process dying (session closed, task stopped) touches no file.
 */
export function watchAgent(root: string, hub: EventHub, intervalMs = 1000): () => void {
  let last = "";
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const status = await agentStatus(root);
      const key = JSON.stringify(status);
      if (key !== last) {
        last = key;
        hub.broadcast({ type: "agent:changed", status });
      }
    } finally {
      busy = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  return () => clearInterval(timer);
}

let activeOwner: string | undefined;

/** How a `redline wait` ended: a round to run, the loop over, or nothing yet. */
export type WaitResult =
  | { kind: "sent"; open: number; replies: number }
  | { kind: "done" }
  | { kind: "timeout" }
  | { kind: "superseded" };

/**
 * `redline wait`: block until the author sends a review from the browser.
 * Needs no daemon — it polls handoff.json directly.
 *
 * A first wait (`resume` false) follows a full pass, so every earlier click
 * is moot: an old Done mustn't end the new loop, an old Send mustn't start a
 * round the author never asked this session for. A re-arm (`resume` true)
 * runs a queued round, then honours a Done clicked mid-pass.
 */
export async function runWait(
  root: string,
  opts: { timeoutMs: number; resume?: boolean; pollMs?: number; heartbeatMs?: number },
): Promise<WaitResult> {
  const pollMs = opts.pollMs ?? 500;
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const prior = await readJson<AgentFile>(agentFile(root));
  let consumed = prior?.consumed ?? 0;
  if (!opts.resume) consumed = Math.max(consumed, (await readJson<HandoffFile>(handoffFile(root)))?.seq ?? 0);
  // a first wait follows the agent's own full pass, which is round 1
  let rounds = opts.resume ? (prior?.rounds ?? 1) : 1;
  let round = opts.resume ? prior?.round : undefined;
  let roundAt = opts.resume ? prior?.roundAt : undefined;
  const session = (opts.resume && prior?.session) || randomUUID();

  const owner = (activeOwner = randomUUID());
  const write = (state: AgentFile["state"], pid: number | null) =>
    writeJson(agentFile(root), {
      state,
      pid,
      owner,
      consumed,
      at: new Date().toISOString(),
      round,
      roundAt,
      rounds,
      session,
    } satisfies AgentFile);
  // a second `redline wait` took over (the agent re-armed twice): only one
  // listener may wake per send, and a stale one must not overwrite its state
  const superseded = async () => (await readJson<AgentFile>(agentFile(root)))?.owner !== owner;
  await write("listening", process.pid);
  let lastBeat = Date.now();

  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    if (await superseded()) return { kind: "superseded" };

    const handoff = await readJson<HandoffFile>(handoffFile(root));
    const done = handoff?.action === "done" && handoff.seq > consumed;
    // "Stop waiting" told the author the agent stopped: a queued round
    // mustn't then run behind that
    if (sendSeqOf(handoff) > consumed && !(done && handoff?.force)) {
      consumed = sendSeqOf(handoff);
      const comments = await listOpenComments(new DocStore(root));
      if (await superseded()) return { kind: "superseded" };
      if (comments.length > 0) {
        round = comments.map((c) => ({ path: c.path, id: c.id }));
        roundAt = new Date().toISOString();
        rounds += 1;
        await write("working", process.pid);
        return {
          kind: "sent",
          open: comments.length,
          // the author answered a proposal: the last word in the thread is theirs
          replies: comments.filter((c) => c.thread.at(-1)?.by === "author").length,
        };
      }
      // nothing left to do (the last pass already covered it): don't spend
      // an agent turn — record it and keep listening
      await write("listening", process.pid);
      lastBeat = Date.now();
    } else if (done) {
      if (await superseded()) return { kind: "superseded" };
      consumed = handoff.seq;
      await write("finished", null);
      return { kind: "done" };
    }

    if (Date.now() >= deadline) {
      if (await superseded()) return { kind: "superseded" };
      await write("rearming", null);
      return { kind: "timeout" };
    }
    if (Date.now() - lastBeat >= heartbeatMs) {
      if (await superseded()) return { kind: "superseded" };
      await write("listening", process.pid);
      lastBeat = Date.now();
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/**
 * `redline wait --stop`: the agent is leaving the loop (the user moved on).
 * Clears a "working" bar, and ends any wait still listening.
 */
export async function stopListening(root: string): Promise<void> {
  const [agent, handoff] = await Promise.all([
    readJson<AgentFile>(agentFile(root)),
    readJson<HandoffFile>(handoffFile(root)),
  ]);
  // the author's Done (kept, or not yet seen by a wait) ended this loop
  // too — if there was a loop to end
  const done =
    handoff?.action === "done" &&
    handoff.seq > (agent?.consumed ?? 0) &&
    (agent?.state === "working" || agent?.state === "listening" || agent?.state === "rearming");
  await writeJson(agentFile(root), {
    state: agent?.state === "finished" || done ? "finished" : "absent",
    pid: null,
    consumed: agent?.consumed ?? 0,
    at: new Date().toISOString(),
    round: agent?.round,
    roundAt: agent?.roundAt,
    rounds: agent?.rounds,
    session: agent?.session,
  } satisfies AgentFile);
}

/** Stop advertising "listening" when the wait is killed (task stopped, session closed). */
export async function releaseWait(root: string): Promise<void> {
  const agent = await readJson<AgentFile>(agentFile(root));
  if (agent?.state === "listening" && agent.owner === activeOwner) {
    await writeJson(agentFile(root), { ...agent, state: "absent", pid: null });
  }
}

/** POSIX-shell-quote an argument only when it needs it. */
const shellArg = (arg: string) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`);

/**
 * The exact command the agent runs to keep listening. The folder is absolute:
 * a background task's `cd` doesn't carry over to the agent's next command.
 */
export function rearmCommand(root: string, timeoutArg?: string): string {
  return [
    "redline wait",
    shellArg(root),
    "--resume",
    ...(timeoutArg !== undefined ? ["--timeout", shellArg(timeoutArg)] : []),
  ].join(" ");
}

/** The line `redline wait` prints for the agent; `rearm` is the exact command to re-run. */
export function describeWait(result: WaitResult, rearm: string): string {
  switch (result.kind) {
    case "sent": {
      const s = result.open === 1 ? "" : "s";
      const replies = result.replies ? ` (${result.replies} answering your proposals)` : "";
      return (
        `redline: review sent — ${result.open} open comment${s}${replies}. ` +
        `Address them (list_comments → edit → resolve_comment), then run \`${rearm}\` to keep listening.`
      );
    }
    case "done":
      return "redline: review finished — stop listening.";
    case "timeout":
      return `redline: still waiting — run \`${rearm}\` to keep listening.`;
    case "superseded":
      return "redline: this wait was replaced or stopped — nothing to do.";
  }
}
