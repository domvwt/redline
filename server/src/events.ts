import type { ServerEvent } from "@redline/shared";

type Listener = (event: ServerEvent) => void;

export class EventHub {
  private listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  broadcast(event: ServerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // a broken SSE connection must not take down the hub
      }
    }
  }
}
