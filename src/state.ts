import {
  STATE_CHANNEL_INIT,
  STATE_LABEL
} from "./labels.js";

type DcSendPayload = string | ArrayBufferLike | Blob | ArrayBufferView;

type DcChannel = {
  label: string;
  readyState: string;
  send: (data: DcSendPayload) => void;
  addEventListener: (
    type: "message",
    listener: (ev: { data: unknown }) => void
  ) => void;
  removeEventListener: (
    type: "message",
    listener: (ev: { data: unknown }) => void
  ) => void;
};

/** Wire codec for state envelopes. Must match Session `backend_opts.codec`. */
export type StateCodec = "json" | "msgpack";

export type StateMeta = {
  seq: number;
  t?: number;
  senderId: string;
  raw: Record<string, unknown>;
};

export type StateHandler = (
  topic: string,
  body: unknown,
  meta: StateMeta
) => void;

export type StatePublisherOptions = {
  channel: DcChannel;
  /** Cap outbound publishes per topic (Hz). Latest pending wins when throttled. */
  maxRateHz?: number;
  /** Defaults to `"json"`. Use `"msgpack"` when Session advertises codec msgpack. */
  codec?: StateCodec;
};

type MsgpackApi = {
  encode: (value: unknown) => Uint8Array;
  decode: (data: Uint8Array) => unknown;
};

let msgpackApi: MsgpackApi | null | undefined;

/** Loads `@msgpack/msgpack` once. Call before using codec `"msgpack"`. */
export async function ensureMsgpackCodec(): Promise<void> {
  if (msgpackApi) return;
  try {
    const mod = (await import("@msgpack/msgpack")) as MsgpackApi;
    msgpackApi = { encode: mod.encode, decode: mod.decode };
  } catch (err) {
    msgpackApi = null;
    throw new Error(
      "msgpack codec requires optional peer dependency @msgpack/msgpack",
      { cause: err }
    );
  }
}

function requireMsgpackSync(): MsgpackApi {
  if (msgpackApi) return msgpackApi;
  throw new Error(
    "msgpack codec: call ensureMsgpackCodec() before publish/receive"
  );
}

function encodeState(
  codec: StateCodec,
  msg: Record<string, unknown>
): DcSendPayload {
  if (codec === "json") return JSON.stringify(msg);
  return requireMsgpackSync().encode(msg);
}

function decodeState(codec: StateCodec, data: unknown): Record<string, unknown> | null {
  try {
    if (codec === "json") {
      let text: string;
      if (typeof data === "string") text = data;
      else if (data instanceof ArrayBuffer) text = new TextDecoder().decode(data);
      else if (ArrayBuffer.isView(data)) {
        text = new TextDecoder().decode(data);
      } else return null;
      return JSON.parse(text) as Record<string, unknown>;
    }

    let bytes: Uint8Array;
    if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
    else if (ArrayBuffer.isView(data)) {
      const view = data as ArrayBufferView;
      bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    } else if (typeof data === "string") {
      bytes = new TextEncoder().encode(data);
    } else return null;

    const decoded = requireMsgpackSync().decode(bytes);
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
      return null;
    }
    return decoded as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Publishes Unity-style state ticks on the `state` datachannel label.
 */
export class StatePublisher {
  private readonly channel: DcChannel;
  private readonly maxRateHz: number | null;
  private readonly codec: StateCodec;
  private readonly seqByTopic = new Map<string, number>();
  private readonly pending = new Map<
    string,
    { body: unknown; seq: number; t: number }
  >();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly lastSentAt = new Map<string, number>();

  constructor(opts: StatePublisherOptions) {
    this.channel = opts.channel;
    this.codec = opts.codec ?? "json";
    this.maxRateHz =
      opts.maxRateHz !== undefined && opts.maxRateHz > 0 ? opts.maxRateHz : null;
  }

  /** Current sequence for `topic` (0 if never published). */
  seq(topic: string): number {
    return this.seqByTopic.get(topic) ?? 0;
  }

  /**
   * Sends `{ type: "state", topic, seq, t, body }`.
   * Returns false if the channel is not open or the tick was coalesced into a pending throttle slot.
   */
  publish(topic: string, body: unknown): boolean {
    if (!topic) throw new Error("topic required");
    const next = (this.seqByTopic.get(topic) ?? 0) + 1;
    this.seqByTopic.set(topic, next);
    const t = Date.now();

    if (this.maxRateHz == null) {
      return this.sendNow(topic, next, t, body);
    }

    const minInterval = 1000 / this.maxRateHz;
    const last = this.lastSentAt.get(topic);
    const now = performance.now();
    const elapsed = last === undefined ? minInterval : now - last;

    if (elapsed >= minInterval && !this.timers.has(topic)) {
      const ok = this.sendNow(topic, next, t, body);
      if (ok) this.lastSentAt.set(topic, now);
      return ok;
    }

    this.pending.set(topic, { body, seq: next, t });
    if (!this.timers.has(topic)) {
      const wait = Math.max(0, minInterval - elapsed);
      const timer = setTimeout(() => {
        this.timers.delete(topic);
        const p = this.pending.get(topic);
        this.pending.delete(topic);
        if (!p) return;
        if (this.sendNow(topic, p.seq, p.t, p.body)) {
          this.lastSentAt.set(topic, performance.now());
        }
      }, wait);
      this.timers.set(topic, timer);
    }
    return false;
  }

  close(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.pending.clear();
  }

  private sendNow(
    topic: string,
    seq: number,
    t: number,
    body: unknown
  ): boolean {
    if (this.channel.readyState !== "open") return false;
    this.channel.send(
      encodeState(this.codec, { type: "state", topic, seq, t, body })
    );
    return true;
  }
}

export type StateReceiverOptions = {
  channel: DcChannel;
  onState: StateHandler;
  /** Defaults to `msg.from` when string, else `"local-unknown"`. */
  resolveSender?: (msg: Record<string, unknown>) => string | null;
  /** Defaults to `"json"`. Must match the publisher / Session codec. */
  codec?: StateCodec;
};

/**
 * Receives state ticks and drops stale seq per (senderId, topic).
 */
export class StateReceiver {
  private readonly channel: DcChannel;
  private readonly onState: StateHandler;
  private readonly codec: StateCodec;
  private readonly resolveSender: (msg: Record<string, unknown>) => string;
  private readonly lastSeq = new Map<string, number>();
  private readonly onMessage: (ev: { data: unknown }) => void;
  dropped = 0;
  accepted = 0;

  constructor(opts: StateReceiverOptions) {
    this.channel = opts.channel;
    this.onState = opts.onState;
    this.codec = opts.codec ?? "json";
    const custom = opts.resolveSender;
    this.resolveSender = (msg) => {
      if (custom) {
        const id = custom(msg);
        if (typeof id === "string" && id !== "") return id;
      }
      if (typeof msg.from === "string" && msg.from !== "") return msg.from;
      return "local-unknown";
    };
    this.onMessage = (ev) => this.handleRaw(ev.data);
    this.channel.addEventListener("message", this.onMessage);
  }

  close(): void {
    this.channel.removeEventListener("message", this.onMessage);
  }

  private handleRaw(data: unknown): void {
    const msg = decodeState(this.codec, data);
    if (!msg || msg.type !== "state") return;
    const topic = typeof msg.topic === "string" ? msg.topic : null;
    const seq = typeof msg.seq === "number" ? msg.seq : null;
    if (!topic || seq == null || seq < 0) return;

    const senderId = this.resolveSender(msg);
    const key = `${senderId}\0${topic}`;
    const last = this.lastSeq.get(key) ?? -1;
    if (seq <= last) {
      this.dropped += 1;
      return;
    }
    this.lastSeq.set(key, seq);
    this.accepted += 1;
    const meta: StateMeta = {
      seq,
      senderId,
      raw: msg
    };
    if (typeof msg.t === "number") {
      meta.t = msg.t;
    }
    this.onState(topic, msg.body, meta);
  }
}

/** Builds publisher + receiver on the `state` label. */
export function createStatePair(opts: {
  getChannel: (label: string) => DcChannel | null | undefined;
  createChannel?: (label: string, init?: RTCDataChannelInit) => DcChannel;
  onState: StateHandler;
  maxRateHz?: number;
  resolveSender?: (msg: Record<string, unknown>) => string | null;
  codec?: StateCodec;
}): { publisher: StatePublisher; receiver: StateReceiver } {
  let channel = opts.getChannel(STATE_LABEL) ?? null;
  if (!channel && opts.createChannel) {
    channel = opts.createChannel(STATE_LABEL, STATE_CHANNEL_INIT);
  }
  if (!channel) {
    throw new Error(`missing datachannel label ${STATE_LABEL}`);
  }
  const publisherOpts: StatePublisherOptions = { channel };
  if (opts.maxRateHz !== undefined) {
    publisherOpts.maxRateHz = opts.maxRateHz;
  }
  if (opts.codec !== undefined) {
    publisherOpts.codec = opts.codec;
  }
  const receiverOpts: StateReceiverOptions = {
    channel,
    onState: opts.onState
  };
  if (opts.resolveSender) {
    receiverOpts.resolveSender = opts.resolveSender;
  }
  if (opts.codec !== undefined) {
    receiverOpts.codec = opts.codec;
  }
  return {
    publisher: new StatePublisher(publisherOpts),
    receiver: new StateReceiver(receiverOpts)
  };
}

export { STATE_CHANNEL_INIT };
