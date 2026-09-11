import { ControlSignaling, SignalingError } from "./signaling.js";
import { defaultDataChannelInit } from "./labels.js";
import type {
  ConnectOptions,
  FeedsDiffFrame,
  FeedsSnapshotFrame,
  IceCandidateParams,
  PresenceDiffFrame,
  PresenceSnapshotFrame,
  SubscribeParams,
  TalkingFrame
} from "./types.js";

type ConnectionStateHandler = (state: string) => void;
type DataChannelHandler = (channel: RTCDataChannel) => void;
type ErrorHandler = (err: Error) => void;

/**
 * One Control WS session + one RTCPeerConnection.
 * Token must be host-minted; this class never mints.
 *
 * ICE candidates are buffered until after offer/answer (server rejects ice before offer).
 * After connect, further candidates are serialized and each awaits `ice_ok`.
 */
export class XylonRoom {
  onconnectionstatechange: ConnectionStateHandler | null = null;
  ondatachannel: DataChannelHandler | null = null;
  onerror: ErrorHandler | null = null;
  /** Membership snapshot after Control WS join. */
  onPresenceSnapshot: ((frame: PresenceSnapshotFrame) => void) | null = null;
  /** Membership join/leave while connected. */
  onPresenceDiff: ((frame: PresenceDiffFrame) => void) | null = null;
  /** Active A/V publishers snapshot (conference feeds). */
  onFeedsSnapshot: ((frame: FeedsSnapshotFrame) => void) | null = null;
  /** Publisher published / unpublished. */
  onFeedsDiff: ((frame: FeedsDiffFrame) => void) | null = null;
  /** Talking / stopped-talking (layout only; never auto-subscribe). */
  onTalking: ((frame: TalkingFrame) => void) | null = null;

  private signaling: ControlSignaling | null = null;
  private pc: RTCPeerConnection | null = null;
  private _sessionId: string | null = null;
  private closed = false;
  /** False until remote answer applied; candidates queue until then. */
  private iceReady = false;
  private iceBuffer: IceCandidateParams[] = [];
  /** Serial chain for post-connect (and in-flight) ICE so each awaits ice_ok. */
  private iceTail: Promise<void> = Promise.resolve();
  private localChannels = new Map<string, RTCDataChannel>();
  /** Server trickle ICE buffered until remote description is set. */
  private remoteReady = false;
  private serverIceBuffer: Array<{
    candidate: string;
    sdpMid: string;
    sdpMLineIndex?: number;
  }> = [];

  get peerConnection(): RTCPeerConnection | null {
    return this.pc;
  }

  get sessionId(): string | null {
    return this._sessionId;
  }

  async connect(opts: ConnectOptions): Promise<void> {
    if (this.signaling || this.pc) {
      throw new SignalingError("already_connected");
    }
    this.closed = false;
    this.iceReady = false;
    this.iceBuffer = [];
    this.iceTail = Promise.resolve();
    this.localChannels.clear();
    this.remoteReady = false;
    this.serverIceBuffer = [];

    const WebSocketImpl = opts.WebSocketImpl ?? WebSocket;
    const PCImpl = opts.RTCPeerConnectionImpl ?? RTCPeerConnection;

    const token = await resolveToken(opts);

    this.signaling = await ControlSignaling.connect(opts.wsUrl, WebSocketImpl);
    this.wireSignaling(this.signaling);

    const joinParams: {
      token?: string;
      library?: string;
      tenantId?: string;
      sessionId?: string;
      participantId: string;
      backendOpts?: Record<string, unknown>;
    } = {
      participantId: opts.participantId ?? "p1"
    };
    if (token !== undefined) joinParams.token = token;
    if (opts.library !== undefined) joinParams.library = opts.library;
    if (opts.tenantId !== undefined) joinParams.tenantId = opts.tenantId;
    if (opts.sessionId !== undefined) joinParams.sessionId = opts.sessionId;
    if (opts.backendOpts !== undefined) joinParams.backendOpts = opts.backendOpts;

    const joined = await this.signaling.join(joinParams);
    this._sessionId = joined.sessionId;

    this.pc = new PCImpl({ iceServers: opts.iceServers ?? [] });
    this.wirePc(this.pc);

    for (const label of opts.dataChannelLabels ?? []) {
      const dc = this.pc.createDataChannel(label, defaultDataChannelInit(label));
      this.localChannels.set(label, dc);
    }

    if (opts.mediaStream) {
      for (const track of opts.mediaStream.getTracks()) {
        this.pc.addTrack(track, opts.mediaStream);
      }
    }

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);

    const localSdp = this.pc.localDescription?.sdp;
    if (!localSdp) throw new SignalingError("missing_local_sdp");

    const { sdp: answer } = await this.signaling.offer(localSdp);
    await this.pc.setRemoteDescription({ type: "answer", sdp: answer });
    this.remoteReady = true;
    await this.flushServerIceBuffer();

    this.iceReady = true;
    await this.flushIceBuffer();

    for (const label of opts.dataChannelLabels ?? []) {
      const dc = this.localChannels.get(label);
      if (dc) await waitDataChannelOpen(dc, opts.dataChannelTimeoutMs ?? 15_000);
    }

    if (this.closed) throw new SignalingError("closed");
    this.emitConnectionState(this.pc.connectionState || "connected");
  }

  /** Selective subscribe (conference `subscribe_mode: manual`). */
  subscribe(params: SubscribeParams): Promise<void> {
    return this.requireSignaling().subscribe(params);
  }

  unsubscribe(params: SubscribeParams): Promise<void> {
    return this.requireSignaling().unsubscribe(params);
  }

  /** Same-codec publisher rebind without renegotiation. */
  switch(params: SubscribeParams): Promise<void> {
    return this.requireSignaling().switch(params);
  }

  createDataChannel(label: string, init?: RTCDataChannelInit): RTCDataChannel {
    if (!this.pc) throw new SignalingError("not_connected");
    const existing = this.localChannels.get(label);
    if (existing) return existing;
    const defaults: RTCDataChannelInit = {
      ...defaultDataChannelInit(label),
      ...(init ?? {})
    };
    const dc = this.pc.createDataChannel(label, defaults);
    this.localChannels.set(label, dc);
    return dc;
  }

  /** Local channel opened at connect via `dataChannelLabels`, if any. */
  dataChannel(label: string): RTCDataChannel | null {
    return this.localChannels.get(label) ?? null;
  }

  close(): void {
    this.closed = true;
    this.iceBuffer = [];
    this.serverIceBuffer = [];
    this.localChannels.clear();
    try {
      this.pc?.close();
    } catch {
      /* ignore */
    }
    this.pc = null;
    try {
      this.signaling?.close();
    } catch {
      /* ignore */
    }
    this.signaling = null;
    this.emitConnectionState("closed");
  }

  private requireSignaling(): ControlSignaling {
    if (!this.signaling || this.closed) throw new SignalingError("not_connected");
    return this.signaling;
  }

  private wireSignaling(sig: ControlSignaling): void {
    sig.onServerIce = (frame) => {
      if (this.closed) return;
      const candidate = frame.candidate;
      if (typeof candidate !== "string" || candidate === "") return;
      const mid = frame.sdpMid ?? "0";
      const entry = {
        candidate,
        sdpMid: mid,
        ...(typeof frame.sdpMLineIndex === "number"
          ? { sdpMLineIndex: frame.sdpMLineIndex }
          : {})
      };
      if (!this.remoteReady || !this.pc) {
        this.serverIceBuffer.push(entry);
        return;
      }
      void this.applyServerIce(entry);
    };

    sig.onServerIceComplete = () => {
      /* gather done; no PC API required */
    };

    sig.onPresenceSnapshot = (frame) => {
      if (this.closed) return;
      this.onPresenceSnapshot?.(frame);
    };

    sig.onPresenceDiff = (frame) => {
      if (this.closed) return;
      this.onPresenceDiff?.(frame);
    };

    sig.onFeedsSnapshot = (frame) => {
      if (this.closed) return;
      this.onFeedsSnapshot?.(frame);
    };

    sig.onFeedsDiff = (frame) => {
      if (this.closed) return;
      this.onFeedsDiff?.(frame);
    };

    sig.onTalking = (frame) => {
      if (this.closed) return;
      this.onTalking?.(frame);
    };
  }

  private async flushServerIceBuffer(): Promise<void> {
    const batch = this.serverIceBuffer;
    this.serverIceBuffer = [];
    for (const entry of batch) {
      await this.applyServerIce(entry);
    }
  }

  private async applyServerIce(entry: {
    candidate: string;
    sdpMid: string;
    sdpMLineIndex?: number;
  }): Promise<void> {
    const pc = this.pc;
    if (!pc || this.closed) return;
    try {
      await pc.addIceCandidate({
        candidate: entry.candidate,
        sdpMid: entry.sdpMid,
        ...(entry.sdpMLineIndex != null ? { sdpMLineIndex: entry.sdpMLineIndex } : {})
      });
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      this.onerror?.(e);
    }
  }

  private wirePc(pc: RTCPeerConnection): void {
    pc.onconnectionstatechange = () => {
      this.emitConnectionState(pc.connectionState);
    };

    pc.ondatachannel = (ev) => {
      this.ondatachannel?.(ev.channel);
    };

    pc.onicecandidate = (ev) => {
      if (this.closed) return;

      if (ev.candidate == null) {
        this.handleIce({
          candidate: null,
          sdpMid: "0",
          endOfCandidates: true
        });
        return;
      }

      const mid = ev.candidate.sdpMid;
      if (!mid) {
        this.onerror?.(new SignalingError("missing_mid"));
        return;
      }

      this.handleIce({
        candidate: ev.candidate.candidate,
        sdpMid: mid,
        ...(ev.candidate.sdpMLineIndex != null
          ? { sdpMLineIndex: ev.candidate.sdpMLineIndex }
          : {})
      });
    };
  }

  private handleIce(params: IceCandidateParams): void {
    if (!this.iceReady) {
      this.iceBuffer.push(params);
      return;
    }
    this.enqueueIce(params);
  }

  private async flushIceBuffer(): Promise<void> {
    const batch = this.iceBuffer;
    this.iceBuffer = [];
    for (const params of batch) {
      await this.sendIce(params, true);
    }
    // Drain any candidates that arrived during flush via enqueueIce.
    await this.iceTail;
  }

  /** Serialize ICE sends; failures go to onerror without unhandled rejection. */
  private enqueueIce(params: IceCandidateParams): void {
    this.iceTail = this.iceTail
      .then(() => this.sendIce(params, false))
      .catch(() => {
        /* sendIce already reported via onerror when rethrowing=false path */
      });
  }

  private async sendIce(params: IceCandidateParams, rethrow: boolean): Promise<void> {
    const sig = this.signaling;
    if (!sig || this.closed) return;
    try {
      await sig.ice(params);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      this.onerror?.(e);
      if (rethrow) throw e;
    }
  }

  private emitConnectionState(state: string): void {
    this.onconnectionstatechange?.(state);
  }
}

async function resolveToken(opts: ConnectOptions): Promise<string | undefined> {
  if (opts.getToken) {
    const t = await opts.getToken();
    if (typeof t !== "string" || t === "") {
      throw new SignalingError("empty_token");
    }
    return t;
  }
  return opts.token;
}

/** Resolves when `dc` is open, or rejects on close/timeout. */
export function waitDataChannelOpen(
  dc: RTCDataChannel,
  timeoutMs = 15_000
): Promise<void> {
  if (dc.readyState === "open") return Promise.resolve();
  if (dc.readyState === "closed" || dc.readyState === "closing") {
    return Promise.reject(new SignalingError("datachannel_closed"));
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new SignalingError("datachannel_timeout"));
    }, timeoutMs);

    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new SignalingError("datachannel_closed"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      dc.removeEventListener("open", onOpen);
      dc.removeEventListener("close", onClose);
    };

    dc.addEventListener("open", onOpen);
    dc.addEventListener("close", onClose);
  });
}
