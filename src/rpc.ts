import { RPC_LABEL } from "./labels.js";

export type RpcHandler = (
  payload: unknown,
  callerId: string
) => unknown | Promise<unknown>;

export type PerformRpcOptions = {
  timeoutMs?: number;
};

type Pending = {
  resolve: (payload: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Error from a failed or timed-out `performRpc`.
 */
export class RpcError extends Error {
  readonly code: string;
  readonly id?: string;

  constructor(code: string, message: string, id?: string) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    if (id !== undefined) {
      this.id = id;
    }
  }
}

type RpcChannel = {
  label: string;
  readyState: string;
  send: (data: string) => void;
  addEventListener: (
    type: "message",
    listener: (ev: { data: unknown }) => void
  ) => void;
  removeEventListener: (
    type: "message",
    listener: (ev: { data: unknown }) => void
  ) => void;
};

/**
 * Peer RPC over the `rpc` datachannel label (LiveKit-style performRpc).
 *
 * With backend `rpc_router: true`, the server fans `rpc.req` only to `to`.
 * Without it, every peer may receive the bytes -- this client still ignores
 * requests where `to` is not the local participant id.
 */
export class RpcClient {
  readonly localParticipantId: string;
  private readonly channel: RpcChannel;
  private readonly methods = new Map<string, RpcHandler>();
  private readonly pending = new Map<string, Pending>();
  private readonly onMessage: (ev: { data: unknown }) => void;

  constructor(opts: { localParticipantId: string; channel: RpcChannel }) {
    if (!opts.localParticipantId) {
      throw new Error("localParticipantId required");
    }
    this.localParticipantId = opts.localParticipantId;
    this.channel = opts.channel;
    this.onMessage = (ev) => this.handleRaw(ev.data);
    this.channel.addEventListener("message", this.onMessage);
  }

  /** Registers a method handler invoked for inbound `rpc.req`. */
  registerRpcMethod(method: string, handler: RpcHandler): void {
    this.methods.set(method, handler);
  }

  /** Removes a previously registered method. */
  unregisterRpcMethod(method: string): void {
    this.methods.delete(method);
  }

  /**
   * Sends `rpc.req` and waits for matching `rpc.res` / `rpc.err`.
   */
  performRpc(
    destinationId: string,
    method: string,
    payload: unknown,
    opts: PerformRpcOptions = {}
  ): Promise<unknown> {
    if (this.channel.readyState !== "open") {
      return Promise.reject(new RpcError("datachannel_closed", "rpc channel not open"));
    }
    const id = cryptoRandomId();
    const timeoutMs = opts.timeoutMs ?? 5000;
    const body = JSON.stringify({
      type: "rpc.req",
      id,
      method,
      to: destinationId,
      payload
    });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError("timeout", `rpc ${method} timed out`, id));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.channel.send(body);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(
          new RpcError(
            "send_failed",
            err instanceof Error ? err.message : "send failed",
            id
          )
        );
      }
    });
  }

  /** Detach message listener and reject pending calls. */
  close(): void {
    this.channel.removeEventListener("message", this.onMessage);
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new RpcError("datachannel_closed", "rpc client closed", id));
    }
    this.pending.clear();
  }

  private handleRaw(data: unknown): void {
    let text: string;
    if (typeof data === "string") text = data;
    else if (data instanceof ArrayBuffer) text = new TextDecoder().decode(data);
    else return;

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }

    const type = msg.type;
    if (type === "rpc.req") {
      void this.handleRequest(msg);
      return;
    }
    if (type === "rpc.res" || type === "rpc.err") {
      this.handleReply(msg);
    }
  }

  private async handleRequest(msg: Record<string, unknown>): Promise<void> {
    const to = msg.to;
    if (typeof to === "string" && to !== this.localParticipantId) {
      return;
    }
    const id = typeof msg.id === "string" ? msg.id : null;
    const method = typeof msg.method === "string" ? msg.method : null;
    const from = typeof msg.from === "string" ? msg.from : "";
    if (!id || !method) return;

    const handler = this.methods.get(method);
    if (!handler) {
      this.sendJson({
        type: "rpc.err",
        id,
        code: "not_found",
        message: `unknown method ${method}`,
        to: from || undefined
      });
      return;
    }

    try {
      const result = await handler(msg.payload, from);
      this.sendJson({
        type: "rpc.res",
        id,
        payload: result ?? null,
        to: from || undefined
      });
    } catch (err) {
      this.sendJson({
        type: "rpc.err",
        id,
        code: "handler_error",
        message: err instanceof Error ? err.message : "handler error",
        to: from || undefined
      });
    }
  }

  private handleReply(msg: Record<string, unknown>): void {
    const id = typeof msg.id === "string" ? msg.id : null;
    if (!id) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if (msg.type === "rpc.err") {
      pending.reject(
        new RpcError(
          typeof msg.code === "string" ? msg.code : "error",
          typeof msg.message === "string" ? msg.message : "rpc error",
          id
        )
      );
      return;
    }
    pending.resolve(msg.payload);
  }

  private sendJson(obj: Record<string, unknown>): void {
    if (this.channel.readyState !== "open") return;
    this.channel.send(JSON.stringify(obj));
  }
}

/** Opens RpcClient on `room.dataChannel("rpc")` or creates the channel. */
export function createRpcClient(opts: {
  localParticipantId: string;
  getChannel: (label: string) => RpcChannel | null | undefined;
  createChannel?: (label: string) => RpcChannel;
}): RpcClient {
  let channel = opts.getChannel(RPC_LABEL) ?? null;
  if (!channel && opts.createChannel) {
    channel = opts.createChannel(RPC_LABEL);
  }
  if (!channel) {
    throw new Error(`missing datachannel label ${RPC_LABEL}`);
  }
  return new RpcClient({
    localParticipantId: opts.localParticipantId,
    channel
  });
}

function cryptoRandomId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `rpc-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
