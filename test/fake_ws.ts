import type { WsLike } from "../src/types.js";

type Listener = (ev: { data?: string; type: string }) => void;

/** In-memory WebSocket for unit tests. Opens on next microtask. */
export class FakeWebSocket implements WsLike {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  /** Optional sync auto-reply from parsed outbound frame. */
  autoReply: ((frame: Record<string, unknown>) => Record<string, unknown> | null) | null =
    null;
  private listeners = new Map<string, Set<Listener>>();

  constructor(_url: string) {
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.emit("open", { type: "open" });
    });
  }

  send(data: string): void {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new Error("WebSocket is not open");
    }
    this.sent.push(data);
    if (this.autoReply) {
      const frame = JSON.parse(data) as Record<string, unknown>;
      const response = this.autoReply(frame);
      if (response) {
        queueMicrotask(() => this.reply(response));
      }
    }
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", { type: "close" });
  }

  addEventListener(type: string, listener: Listener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  /** Server -> client text frame. */
  reply(obj: unknown): void {
    this.emit("message", { type: "message", data: JSON.stringify(obj) });
  }

  waitOpen(): Promise<void> {
    if (this.readyState === FakeWebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve) => {
      this.addEventListener("open", () => resolve());
    });
  }

  private emit(type: string, ev: { data?: string; type: string }): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(ev);
    }
  }
}
