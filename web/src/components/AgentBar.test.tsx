import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentStatus } from "@redline/shared";

const sendHandoff = vi.hoisted(() => vi.fn());
vi.mock("../api.ts", () => ({ api: { sendHandoff } }));

import { AgentBar } from "./AgentBar.tsx";

const LISTENING: AgentStatus = {
  state: "listening",
  pending: false,
  stopping: false,
  finished: false,
  round: null,
  rounds: 1,
  session: "s1",
};
const WORKING: AgentStatus = {
  ...LISTENING,
  state: "working",
  round: { total: 3, answered: 1, held: ["b", "c"] },
  rounds: 2,
};
const ABSENT: AgentStatus = { ...LISTENING, state: "absent" };
const STOPPED: AgentStatus = { ...ABSENT, finished: true, rounds: 3 };

let onNotice: ReturnType<typeof vi.fn>;

function renderBar(status: AgentStatus | null, readyCount = 0) {
  const view = render(<AgentBar status={status} readyCount={readyCount} onNotice={onNotice} />);
  return {
    ...view,
    update: (next: AgentStatus | null, ready = readyCount) =>
      view.rerender(<AgentBar status={next} readyCount={ready} onNotice={onNotice} />),
  };
}

const label = () => document.querySelector(".rl-agent-label")?.textContent;
const detail = () => document.querySelector(".rl-agent-detail")?.textContent;
const action = () => document.querySelector<HTMLButtonElement>(".rl-agent-act")!;
const moreButton = () => screen.getByRole("button", { name: "More agent actions" });
const menuItems = () => screen.queryAllByRole("menuitem");
const openMenu = () => fireEvent.click(moreButton());
const ctrlEnter = (target: EventTarget = window) => {
  const event = new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true });
  act(() => void target.dispatchEvent(event));
  return event;
};

beforeEach(() => {
  onNotice = vi.fn();
  sendHandoff.mockReset().mockResolvedValue(LISTENING);
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  // jsdom has no clipboard: drop any stub a test defined
  delete (navigator as { clipboard?: unknown }).clipboard;
});

describe("agent bar states", () => {
  it("renders nothing before the first status arrives", () => {
    const { container } = renderBar(null);
    expect(container.innerHTML).toBe("");
  });

  it("listening with nothing open: the send is off", () => {
    renderBar(LISTENING, 0);
    expect(label()).toBe("Listening");
    expect(detail()).toBe("Nothing to send");
    expect(action().textContent).toBe("Send to agent");
    expect(action().disabled).toBe(true);
  });

  it("listening with comments ready: Send hands them over", async () => {
    renderBar(LISTENING, 3);
    expect(detail()).toBe("3 ready to send");
    expect(action().disabled).toBe(false);
    fireEvent.click(action());
    await waitFor(() => expect(sendHandoff).toHaveBeenCalledWith("send"));
  });

  it("a send not yet picked up reads as Sending…", () => {
    renderBar({ ...LISTENING, pending: true }, 3);
    expect(action().textContent).toBe("Sending…");
    expect(action().disabled).toBe(true);
  });

  it("working: progress, and Queue offers only what the agent isn't holding", async () => {
    renderBar(WORKING, 4);
    expect(label()).toBe("Working");
    expect(detail()).toContain("1 of 3 answered");
    expect(document.querySelectorAll(".rl-agent-segments > span")).toHaveLength(3);
    expect(document.querySelectorAll(".rl-agent-segments > .done")).toHaveLength(1);
    expect(action().textContent).toBe("Queue 2 →");
    fireEvent.click(action());
    await waitFor(() => expect(sendHandoff).toHaveBeenCalledWith("send"));
  });

  it("working with nothing beyond the round: Queue is off", () => {
    renderBar(WORKING, 2);
    expect(action().textContent).toBe("Queue");
    expect(action().disabled).toBe(true);
  });

  it("a queued round reads as queued", () => {
    renderBar({ ...WORKING, pending: true }, 4);
    expect(action().textContent).toBe("Next round queued");
    expect(action().disabled).toBe(true);
  });

  it("stopping: says what's left before the agent stops", () => {
    const { update } = renderBar({ ...WORKING, stopping: true }, 4);
    expect(label()).toBe("Stopping");
    expect(action().textContent).toBe("Stops after this pass");
    expect(action().disabled).toBe(true);
    update({ ...WORKING, stopping: true, pending: true });
    expect(action().textContent).toBe("Then one more round");
  });

  it("a daemon reporting an older round shape shows no progress rather than crashing", () => {
    renderBar({ ...WORKING, round: { total: 2, answered: 1 } as unknown as AgentStatus["round"] }, 1);
    expect(label()).toBe("Working");
    expect(detail()).toBe("Working through your comments");
  });

  it("a send nobody picked up: Nobody listening, with the start command", () => {
    renderBar({ ...ABSENT, pending: true }, 2);
    expect(label()).toBe("Nobody listening");
    expect(detail()).toBe("Sent, waiting for an agent");
    expect(action().textContent).toBe("/redline-comments");
  });

  it("no agent: counts what's ready and offers the start command", () => {
    renderBar(ABSENT, 2);
    expect(label()).toBe("No agent");
    expect(detail()).toBe("2 ready · start one in a terminal");
    expect(action().textContent).toBe("/redline-comments");
  });

  it("the copy button copies the command, and falls back to a notice without a clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderBar(ABSENT);
    fireEvent.click(action());
    expect(writeText).toHaveBeenCalledWith("/redline-comments");
    await waitFor(() => expect(action().textContent).toBe("Copied ✓"));
    cleanup();

    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    renderBar(ABSENT);
    fireEvent.click(action());
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith(expect.stringContaining("/redline-comments")));
  });

  it("a failed handoff surfaces as a notice", async () => {
    sendHandoff.mockRejectedValue(new Error("daemon gone"));
    renderBar(LISTENING, 1);
    fireEvent.click(action());
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("Error: daemon gone"));
    expect(action().disabled).toBe(false);
  });
});

describe("Dismiss", () => {
  it("clears Agent stopped for that session only", () => {
    const { update } = renderBar(STOPPED);
    expect(label()).toBe("Agent stopped");
    expect(detail()).toBe("after 3 rounds");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(label()).toBe("No agent");
    expect(localStorage.getItem("redline:agent-bar-dismissed")).toBe("s1");

    // a session that runs and stops later gets its own notice
    update({ ...STOPPED, session: "s2", rounds: 1 });
    expect(label()).toBe("Agent stopped");
    expect(detail()).toBe("after 1 round");
  });

  it("survives a reload", () => {
    localStorage.setItem("redline:agent-bar-dismissed", "s1");
    renderBar(STOPPED);
    expect(label()).toBe("No agent");
  });

  it("still renders when storage is blocked", () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    try {
      renderBar(STOPPED);
      fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
      expect(label()).toBe("No agent");
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });
});

describe("the ⋯ menu", () => {
  it("Done for now sends a Done", async () => {
    renderBar(LISTENING, 1);
    openMenu();
    expect(menuItems().map((i) => i.querySelector("b")?.textContent)).toEqual(["Done for now", "Collapse bar"]);
    fireEvent.click(menuItems()[0]);
    expect(menuItems()).toHaveLength(0);
    await waitFor(() => expect(sendHandoff).toHaveBeenCalledWith("done"));
    expect(document.activeElement).toBe(moreButton());
  });

  it("while stopping, Stop waiting sends another Done", async () => {
    renderBar({ ...WORKING, stopping: true });
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /Stop waiting/ }));
    await waitFor(() => expect(sendHandoff).toHaveBeenCalledWith("done"));
  });

  it("with a send nobody picked up, Drop the send withdraws it", async () => {
    renderBar({ ...ABSENT, pending: true }, 1);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /Drop the send/ }));
    await waitFor(() => expect(sendHandoff).toHaveBeenCalledWith("drop"));
  });

  it("with no agent and nothing sent, only Collapse is offered", () => {
    renderBar(ABSENT);
    openMenu();
    expect(menuItems().map((i) => i.querySelector("b")?.textContent)).toEqual(["Collapse bar"]);
  });

  it("arrow keys move between items and wrap", () => {
    renderBar(LISTENING);
    openMenu();
    const [done, collapse] = menuItems();
    expect(document.activeElement).toBe(done);
    fireEvent.keyDown(done, { key: "ArrowDown" });
    expect(document.activeElement).toBe(collapse);
    fireEvent.keyDown(collapse, { key: "ArrowDown" });
    expect(document.activeElement).toBe(done);
    fireEvent.keyDown(done, { key: "ArrowUp" });
    expect(document.activeElement).toBe(collapse);
  });

  it("Escape closes it, returns focus to ⋯, and doesn't reach the page", () => {
    const pageKeys = vi.fn();
    window.addEventListener("keydown", pageKeys);
    try {
      renderBar(LISTENING);
      openMenu();
      fireEvent.keyDown(menuItems()[0], { key: "Escape" });
      expect(menuItems()).toHaveLength(0);
      expect(document.activeElement).toBe(moreButton());
      expect(pageKeys).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", pageKeys);
    }
  });

  it("a click or focus elsewhere closes it", () => {
    renderBar(LISTENING);
    openMenu();
    fireEvent.mouseDown(document.body);
    expect(menuItems()).toHaveLength(0);

    openMenu();
    fireEvent.focusIn(document.body);
    expect(menuItems()).toHaveLength(0);
  });

  it("Collapse shrinks the bar to a pill that remembers, and the pill opens it again", async () => {
    renderBar(LISTENING, 2);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /Collapse bar/ }));
    const pill = screen.getByRole("button", { name: "Agent: Listening, 2 ready — expand" });
    expect(document.querySelector(".rl-agent-bar")).toBeNull();
    expect(localStorage.getItem("redline:agent-bar-collapsed")).toBe("1");
    await waitFor(() => expect(document.activeElement).toBe(pill));

    cleanup();
    renderBar(LISTENING, 2);
    fireEvent.click(screen.getByRole("button", { name: /— expand/ }));
    expect(label()).toBe("Listening");
    expect(localStorage.getItem("redline:agent-bar-collapsed")).toBeNull();
  });
});

describe("⌘↵ / Ctrl ↵", () => {
  it("sends when a send is possible, and claims the key", async () => {
    renderBar(LISTENING, 2);
    expect(ctrlEnter().defaultPrevented).toBe(true);
    await waitFor(() => expect(sendHandoff).toHaveBeenCalledWith("send"));
  });

  it("queues mid-pass", async () => {
    renderBar(WORKING, 4);
    ctrlEnter();
    await waitFor(() => expect(sendHandoff).toHaveBeenCalledWith("send"));
  });

  it("leaves the key alone when there's nothing to send", () => {
    const { update } = renderBar(LISTENING, 0);
    expect(ctrlEnter().defaultPrevented).toBe(false);
    update({ ...LISTENING, pending: true }, 2);
    expect(ctrlEnter().defaultPrevented).toBe(false);
    update({ ...WORKING, stopping: true }, 4);
    expect(ctrlEnter().defaultPrevented).toBe(false);
    update(ABSENT, 2);
    expect(ctrlEnter().defaultPrevented).toBe(false);
    expect(sendHandoff).not.toHaveBeenCalled();
  });

  it("belongs to a text field while typing in one", () => {
    renderBar(LISTENING, 2);
    const field = document.createElement("textarea");
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    document.body.append(field, editor);
    try {
      expect(ctrlEnter(field).defaultPrevented).toBe(false);
      expect(ctrlEnter(editor).defaultPrevented).toBe(false);
      expect(sendHandoff).not.toHaveBeenCalled();
    } finally {
      field.remove();
      editor.remove();
    }
  });
});
