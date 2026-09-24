/** Options for `XylonRoom.connect`. */
export type ConnectOptions = {
  /** Control WS URL, e.g. `wss://edge.example/v1/ws`. */
  wsUrl: string;
  /**
   * Host-minted HMAC or JWT material (no `Bearer ` prefix).
   * Required for `auth: :hmac` / `:jwt` unless `getToken` is set.
   * Lab mode may omit if tenant/session are set.
   */
  token?: string;
  /**
   * Host mint hook. When set, called at connect to obtain the token (wins over
   * `token`). Stub for future reconnect/refresh -- v1 does not auto-reconnect.
   */
  getToken?: () => string | Promise<string>;
  /** Backend catalogue id (e.g. `datachannel`, `conference`, `echo`). */
  library?: string;
  /**
   * Passed on Control WS `join` as `backend_opts` when the session is created
   * (e.g. `{ mode: "fanout_except_sender", default_label: "chat" }` or
   * `{ subscribe_mode: "manual" }` for conference).
   */
  backendOpts?: Record<string, unknown>;
  /** Required for `auth: :lab`; optional bind check for HMAC/JWT. */
  tenantId?: string;
  sessionId?: string;
  /** Defaults to `p1`. */
  participantId?: string;
  /** Open these labels with `createDataChannel` before `createOffer`. */
  dataChannelLabels?: string[];
  /** Max wait for each `dataChannelLabels` channel to open (default 15000). */
  dataChannelTimeoutMs?: number;
  /** Max wait for ICE gathering before posting offer (default 5000). */
  iceGatherTimeoutMs?: number;
  /**
   * Local A/V tracks added before `createOffer` (conference / echo).
   * Required for outbound media; omit for datachannel-only rooms.
   */
  mediaStream?: MediaStream;
  /**
   * Optional video publish knobs (simulcast / SVC). When set with a video
   * track in `mediaStream`, connect uses `addTransceiver` instead of
   * `addTrack` so Chrome can emit SIM encodings or `scalabilityMode`.
   */
  videoPublish?: VideoPublishOptions;
  iceServers?: RTCIceServer[];
  /** Injected WebSocket constructor (tests). Defaults to global `WebSocket`. */
  WebSocketImpl?: typeof WebSocket;
  /** Injected RTCPeerConnection constructor (tests). */
  RTCPeerConnectionImpl?: typeof RTCPeerConnection;
};

/** Minimal WebSocket surface used by signaling (browser or fake). */
export type WsMessageEvent = {
  data?: unknown;
};

export type WsLike = {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (ev: WsMessageEvent) => void
  ): void;
  removeEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (ev: WsMessageEvent) => void
  ): void;
};

export type MediaKind = "audio" | "video";

/**
 * Publish-side video options for Chrome SIM / SVC labs.
 *
 * ## Fields
 *
 * - `codec` -- prefer this video mime (e.g. `video/VP8`, `video/VP9`, `video/AV1`)
 * - `simulcast` -- when true, three RID encodings (q/h/f) for VP8 SIM
 * - `scalabilityMode` -- Chrome SVC mode (e.g. `L3T3_KEY`) on a single encoding
 * - `encodings` -- explicit `RTCRtpEncodingParameters` (wins over simulcast defaults)
 */
export type VideoPublishOptions = {
  codec?: string;
  simulcast?: boolean;
  scalabilityMode?: string;
  encodings?: RTCRtpEncodingParameters[];
};

/** Params for Control WS subscribe / unsubscribe / switch. */
export type SubscribeParams = {
  publisherId: string;
  /**
   * Media kind. When `mid` is omitted, subscribe uses server `subscribe_all`
   * for that publisher (kind is still sent for hosts that filter).
   */
  kind: MediaKind;
  /** Exact stream mid from `feeds.snapshot` / `feeds.diff` when known. */
  mid?: string;
  /** Simulcast layer index (0..n-1) when the publisher offers SIM. */
  substream?: number;
  /** Simulcast RID when layers carry `rid` from SDP. */
  rid?: string;
  /** Max VP8 temporal layer (TID) to forward; omit for no filter. */
  temporal?: number;
  /** Max VP9 / AV1 SVC spatial layer (Janus `spatial_layer`). */
  spatialLayer?: number;
  /** Max VP9 / AV1 SVC temporal layer (Janus `temporal_layer`). */
  temporalLayer?: number;
};

export type PresenceParticipant = {
  role?: string;
  joined_at?: number;
  meta?: Record<string, unknown>;
};

export type PresenceSnapshotFrame = {
  type: "presence.snapshot";
  participants: Record<string, PresenceParticipant>;
};

export type PresenceDiffFrame = {
  type: "presence.diff";
  action: "join" | "leave";
  participant_id: string;
  role?: string;
  joined_at?: number;
  meta?: Record<string, unknown>;
};

export type FeedStream = {
  mid: string;
  kind: string;
  codec?: string;
};

export type FeedPublisher = {
  participant_id: string;
  /** Current server shape (`Feeds.snapshot_payload`). */
  streams?: FeedStream[];
  /** Legacy field; prefer `streams`. */
  kinds?: string[];
  audio_codec?: string;
  video_codec?: string;
};

export type FeedsSnapshotFrame = {
  type: "feeds.snapshot";
  publishers: FeedPublisher[];
};

export type FeedsDiffFrame = {
  type: "feeds.diff";
  action: "published" | "unpublished";
  participant_id: string;
  streams?: FeedStream[];
  /** Legacy field; prefer `streams`. */
  kinds?: string[];
  audio_codec?: string;
  video_codec?: string;
};

export type GroupsSnapshotFrame = {
  type: "groups.snapshot";
  groups: Record<string, string[]>;
};

export type GroupsDiffFrame = {
  type: "groups.diff";
  action: "create" | "delete" | "add_member" | "remove_member";
  group_id: string;
  participant_id?: string;
};

export type TalkingFrame = {
  type: "talking" | "stopped-talking";
  participant_id: string;
  audio_level_dbov_avg?: number;
};

/** Uplink Dynacast: which SIM RIDs the publisher should keep active. */
export type PublishLayersFrame = {
  type: "publish_layers";
  mid: string;
  layers: Array<{ rid: string; active: boolean }>;
};

export type ServerFrame =
  | { type: "joined"; session_id: string }
  | { type: "answer"; sdp: string }
  | { type: "ice_ok" }
  | {
      type: "ice";
      candidate?: string | null;
      sdpMid?: string;
      sdpMLineIndex?: number;
    }
  | { type: "ice_complete" }
  | PublishLayersFrame
  | { type: "subscribed" }
  | { type: "unsubscribed" }
  | { type: "switched" }
  | { type: "substream_set" }
  | PresenceSnapshotFrame
  | PresenceDiffFrame
  | FeedsSnapshotFrame
  | FeedsDiffFrame
  | GroupsSnapshotFrame
  | GroupsDiffFrame
  | TalkingFrame
  | {
      type: "migrate.required";
      reason?: string;
      tenant_id?: string;
      session_id?: string;
      target?: {
        edge_url?: string | null;
        node?: string;
        region_id?: string;
        role?: string;
      };
    }
  | { type: "error"; reason: string };

export type JoinParams = {
  token?: string;
  library?: string;
  tenantId?: string;
  sessionId?: string;
  participantId?: string;
  backendOpts?: Record<string, unknown>;
};

export type IceCandidateParams = {
  candidate: string | null;
  sdpMid: string;
  sdpMLineIndex?: number | null;
  endOfCandidates?: boolean;
};

export type RestAuth = {
  token: string;
  tenantId: string;
  sessionId: string;
};
