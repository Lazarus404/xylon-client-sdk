import type {
  IceCandidateParams,
  JoinParams,
  ServerFrame,
  SubscribeParams,
  WsLike
} from "./types.js";

type PendingExpect =
  | "joined"
  | "answer"
  | "ice_ok"
  | "subscribed"
  | "unsubscribed"
  | "switched"
  | "substream_set";

/** Error from a Control WS `{ type: "error", reason }` frame. */
export class SignalingError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = "SignalingError";
    this.reason = reason;
  }
}

/**
 * Control WS framing: join / offer / ice / subscribe with request-response waits.
 * One in-flight wait at a time is enough for the room connect sequence.
 * Unsolicited server ice / presence / feeds / talking frames never resolve a
 * pending wait.
 */
export class ControlSignaling {
  /** Fired for outbound server Trickle ICE (full-ICE mode). */
  onServerIce: ((frame: Extract<ServerFrame, { type: "ice" }>) => void) | null = null;
  /** Fired when the server finishes local gather. */
  onServerIceComplete: (() => void) | null = null;
  /** Fired after join with the current Membership map. */
  onPresenceSnapshot:
    | ((frame: Extract<ServerFrame, { type: "presence.snapshot" }>) => void)
    | null = null;
  /** Fired on Membership join/leave for the room. */
  onPresenceDiff:
    | ((frame: Extract<ServerFrame, { type: "presence.diff" }>) => void)
    | null = null;
  /** Fired after join with active A/V publishers (conference feeds). */
  onFeedsSnapshot:
    | ((frame: Extract<ServerFrame, { type: "feeds.snapshot" }>) => void)
    | null = null;
  /** Fired when a publisher publishes or unpublishes A/V. */
  onFeedsDiff:
    | ((frame: Extract<ServerFrame, { type: "feeds.diff" }>) => void)
    | null = null;
  /** Fired after join with named groups map. */
  onGroupsSnapshot:
    | ((frame: Extract<ServerFrame, { type: "groups.snapshot" }>) => void)
    | null = null;
  /** Fired on group create/delete/member change. */
  onGroupsDiff:
    | ((frame: Extract<ServerFrame, { type: "groups.diff" }>) => void)
    | null = null;
  /** Fired on talking / stopped-talking edges (audio-level). */
  onTalking:
    | ((frame: Extract<ServerFrame, { type: "talking" | "stopped-talking" }>) => void)
    | null = null;
  /** Fired when Dynacast asks the publisher to pause/resume SIM encodings. */
  onPublishLayers:
    | ((frame: Extract<ServerFrame, { type: "publish_layers" }>) => void)
    | null = null;

  private pending: {
    expect: PendingExpect;
    resolve: (value: ServerFrame) => void;
    reject: (err: Error) => void;
  } | null = null;

  private readonly onMessage = (ev: { data?: unknown }) => {
    if (typeof ev.data !== "string") return;
    let frame: ServerFrame;
    try {
      frame = JSON.parse(ev.data) as ServerFrame;
    } catch {
      this.failPending(new SignalingError("bad_json"));
      return;
    }
    this.dispatch(frame);
  };

  constructor(private readonly ws: WsLike) {
    this.ws.addEventListener("message", this.onMessage);
  }

  static async connect(
    url: string,
    WebSocketImpl: typeof WebSocket = WebSocket
  ): Promise<ControlSignaling> {
    const ws = new WebSocketImpl(url) as unknown as WsLike;
    await waitOpen(ws);
    return new ControlSignaling(ws);
  }

  join(params: JoinParams): Promise<{ sessionId: string }> {
    const body: Record<string, unknown> = { type: "join" };
    if (params.token) body.token = params.token;
    if (params.library) body.library = params.library;
    if (params.tenantId) body.tenant_id = params.tenantId;
    if (params.sessionId) body.session_id = params.sessionId;
    if (params.participantId) body.participant_id = params.participantId;
    if (params.backendOpts) body.backend_opts = params.backendOpts;

    return this.request("joined", body).then((frame) => {
      const f = frame as { type: "joined"; session_id: string };
      return { sessionId: f.session_id };
    });
  }

  offer(sdp: string): Promise<{ sdp: string }> {
    return this.request("answer", { type: "offer", sdp }).then((frame) => {
      const f = frame as { type: "answer"; sdp: string };
      return { sdp: f.sdp };
    });
  }

  ice(params: IceCandidateParams): Promise<void> {
    const body: Record<string, unknown> = {
      type: "ice",
      candidate: params.candidate,
      sdpMid: params.sdpMid
    };
    if (params.sdpMLineIndex != null) body.sdpMLineIndex = params.sdpMLineIndex;
    if (params.endOfCandidates) body.end_of_candidates = true;

    return this.request("ice_ok", body).then(() => undefined);
  }

  /** Selective subscribe (conference manual). Awaits `{ type: "subscribed" }`. */
  subscribe(params: SubscribeParams): Promise<void> {
    return this.request("subscribed", subscribeBody("subscribe", params)).then(
      () => undefined
    );
  }

  /** Removes a subscribe route. Awaits `{ type: "unsubscribed" }`. */
  unsubscribe(params: SubscribeParams): Promise<void> {
    return this.request("unsubscribed", subscribeBody("unsubscribe", params)).then(
      () => undefined
    );
  }

  /** Same-codec publisher rebind without renegotiation. Awaits `{ type: "switched" }`. */
  switch(params: SubscribeParams): Promise<void> {
    return this.request("switched", subscribeBody("switch", params)).then(() => undefined);
  }

  /**
   * Changes simulcast / SVC layer opts on an existing subscription
   * (`substream` / `rid` / `temporal` / `spatialLayer` / `temporalLayer`).
   * Awaits `{ type: "substream_set" }`. Prefer `mid` from feeds.
   */
  setSubstream(params: SubscribeParams): Promise<void> {
    return this.request("substream_set", subscribeBody("set_substream", params)).then(
      () => undefined
    );
  }

  close(): void {
    this.ws.removeEventListener("message", this.onMessage);
    if (this.pending) {
      this.pending.reject(new SignalingError("closed"));
      this.pending = null;
    }
    this.ws.close();
  }

  get socket(): WsLike {
    return this.ws;
  }

  private request(
    expect: PendingExpect,
    body: Record<string, unknown>
  ): Promise<ServerFrame> {
    if (this.pending) {
      return Promise.reject(new SignalingError("busy"));
    }
    return new Promise((resolve, reject) => {
      this.pending = { expect, resolve, reject };
      try {
        this.ws.send(JSON.stringify(body));
      } catch (err) {
        this.pending = null;
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private dispatch(frame: ServerFrame): void {
    if (frame.type === "ice") {
      this.onServerIce?.(frame);
      return;
    }
    if (frame.type === "ice_complete") {
      this.onServerIceComplete?.();
      return;
    }
    if (frame.type === "presence.snapshot") {
      this.onPresenceSnapshot?.(frame);
      return;
    }
    if (frame.type === "presence.diff") {
      this.onPresenceDiff?.(frame);
      return;
    }
    if (frame.type === "feeds.snapshot") {
      this.onFeedsSnapshot?.(frame);
      return;
    }
    if (frame.type === "feeds.diff") {
      this.onFeedsDiff?.(frame);
      return;
    }
    if (frame.type === "groups.snapshot") {
      this.onGroupsSnapshot?.(frame);
      return;
    }
    if (frame.type === "groups.diff") {
      this.onGroupsDiff?.(frame);
      return;
    }
    if (frame.type === "talking" || frame.type === "stopped-talking") {
      this.onTalking?.(frame);
      return;
    }
    if (frame.type === "publish_layers") {
      this.onPublishLayers?.(frame);
      return;
    }

    if (!this.pending) return;

    if (frame.type === "error") {
      const { reject } = this.pending;
      this.pending = null;
      reject(new SignalingError(String(frame.reason)));
      return;
    }

    if (frame.type !== this.pending.expect) {
      return;
    }

    const { resolve } = this.pending;
    this.pending = null;
    resolve(frame);
  }

  private failPending(err: Error): void {
    if (!this.pending) return;
    const { reject } = this.pending;
    this.pending = null;
    reject(err);
  }
}

function subscribeBody(
  type: "subscribe" | "unsubscribe" | "switch" | "set_substream",
  params: SubscribeParams
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    type,
    publisher_id: params.publisherId,
    kind: params.kind
  };
  if (params.mid) body.mid = params.mid;
  if (params.substream != null) body.substream = params.substream;
  if (params.rid) body.rid = params.rid;
  if (params.temporal != null) body.temporal = params.temporal;
  if (params.spatialLayer != null) body.spatial_layer = params.spatialLayer;
  if (params.temporalLayer != null) body.temporal_layer = params.temporalLayer;
  return body;
}

function waitOpen(ws: WsLike): Promise<void> {
  if (ws.readyState === 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new SignalingError("ws_error"));
    };
    const cleanup = () => {
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onError);
    };
    ws.addEventListener("open", onOpen);
    ws.addEventListener("error", onError);
  });
}
