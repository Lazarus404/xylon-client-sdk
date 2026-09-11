# Xylon Client SDK

Browser TypeScript client for [Xylon](https://github.com/Lazarus404/xylon) Control
WebSocket JSEP. The SDK never holds the shared secret. Browser tokens come from
your **customer admin** backend; Control admin HTTP also goes through that
backend (not Xylon directly).

```text
                     AdminClient.mintToken / presence / moderate / ...
Client app  -->  xylon-client-sdk  -->  customer admin (e.g. :8092)
                                              |
                                              v
                                    platform interface (:8093)
                                              |
                                              v
                                         Xylon Control

Client app  -->  xylon-client-sdk  -->  GET /v1/ws  -->  Xylon Control
                     |
                     +--> RTCPeerConnection <-> XGW Peer (media)
```

## Prerequisites

Xylon Control must be enabled (`config :xylon, control: [enabled: true, ...]`).
With Control off, `GET /v1/ws` returns 404.

Use `auth: :hmac` or `auth: :jwt` for production. Lab (`auth: :lab`) accepts
`tenant_id` + `session_id` on `join` without a crypto token.

## Install / build

```bash
npm install xylon-client-sdk
# or from a checkout:
npm install && npm test && npm run build
```

Published surface: ESM + TypeScript types (`dist/`). Node `>=18`.

## Customer admin client

`AdminClient` talks only to your SaaS admin HTTP API (demo paths match
[xylon-demo-customer-admin-app](https://github.com/Lazarus404/xylon-demo-customer-admin-app)).
Use `prepareRequest`, `defaultHeaders`, and/or `credentials: "include"` so your
app can attach session auth when the admin backend requires it. Lab demos may
omit those.

```ts
import { AdminClient, XylonRoom } from "xylon-client-sdk";

const admin = new AdminClient({
  baseUrl: "http://127.0.0.1:8092",
  // Real apps:
  // credentials: "include",
  // prepareRequest: ({ headers }) => { headers.set("authorization", "Bearer ..."); }
});

const room = new XylonRoom();
await room.connect({
  wsUrl: "ws://127.0.0.1:8080/v1/ws",
  getToken: async () => {
    const { token } = await admin.mintToken({
      session_id: "room-1",
      participant_id: "alice",
      capabilities: [],
      ttl_sec: 300
    });
    return token;
  },
  library: "datachannel",
  dataChannelLabels: ["chat"]
});

const presence = await admin.presence("room-1");
await admin.moderate("room-1", { action: "kick", participant_id: "p2" });
await admin.inject("room-1", { payload: "hi", dest: "all", label: "chat" });
```

## Connect

```ts
import { XylonRoom } from "xylon-client-sdk";

const room = new XylonRoom();
room.onconnectionstatechange = (s) => console.log(s);
room.ondatachannel = (dc) => {
  dc.onmessage = (ev) => console.log(dc.label, ev.data);
};

await room.connect({
  wsUrl: "wss://edge.example/v1/ws",
  getToken: () => fetchTokenFromYourBackend(),
  library: "datachannel",
  dataChannelLabels: ["chat"]
});

const chat = room.dataChannel("chat") || room.createDataChannel("chat");
chat.send("hello");
```

Declare `dataChannelLabels` on connect when channels must appear in the offer SDP.
Opening new labels after connect may require renegotiation that the server does not
support.

`getToken` is preferred over a static `token`. v1 does not auto-reconnect or refresh
mid-session; pass a fresh `getToken` / `token` on the next `connect`.

## RPC (datachannel)

Use labels `chat` / `rpc` / `state` (`GAME_DATA_CHANNEL_LABELS`) and open them in the
offer. Create the Session with `mode: "mfu"` and `rpc_router: true` so the server
delivers `rpc.req` only to `to` (without the router, every peer receives the bytes).

```ts
import {
  GAME_DATA_CHANNEL_LABELS,
  RpcClient,
  XylonRoom,
  createRpcClient
} from "xylon-client-sdk";

const room = new XylonRoom();
await room.connect({
  wsUrl: "wss://edge.example/v1/ws",
  getToken: () => fetchTokenFromYourBackend(),
  library: "datachannel",
  dataChannelLabels: [...GAME_DATA_CHANNEL_LABELS],
  backendOpts: {
    mode: "mfu",
    default_dest: "except_sender",
    labels: [...GAME_DATA_CHANNEL_LABELS],
    rpc_router: true
  }
});

const rpc = createRpcClient({
  localParticipantId: "alice",
  getChannel: (label) => room.dataChannel(label) as RTCDataChannel | null,
  createChannel: (label) => room.createDataChannel(label)
});

rpc.registerRpcMethod("ping", (payload) => ({ pong: payload }));
const result = await rpc.performRpc("bob", "ping", { n: 1 }, { timeoutMs: 2000 });
```

`RpcClient` ignores inbound `rpc.req` when `to` is not the local participant id
(defense in depth). Call `rpc.close()` when leaving the room.

## State (Unity-style ticks)

High-frequency snapshots on the `state` label. Connect opens `state` with
`ordered: false` and `maxRetransmits: 0` (`STATE_CHANNEL_INIT`). The server stamps
`from` (and can drop stale seq when `state_coalesce: true`). The client still drops
`seq <= last` per `(senderId, topic)`.

```ts
import {
  StatePublisher,
  StateReceiver,
  STATE_LABEL,
  STATE_CHANNEL_INIT,
  ensureMsgpackCodec
} from "xylon-client-sdk";

// Prefer dataChannelLabels: ["chat","rpc","state"] on connect so init is applied.
const channel = room.dataChannel(STATE_LABEL)!;
const pub = new StatePublisher({ channel, maxRateHz: 30 });
pub.publish("transform", { x: 1, y: 0, yaw: 90 });

const rec = new StateReceiver({
  channel,
  onState: (topic, body, meta) => {
    console.log(meta.senderId, topic, meta.seq, body);
  }
});
```

Optional MessagePack (match Session `backend_opts: { codec: "msgpack" }`):

```ts
await ensureMsgpackCodec();
const pub = new StatePublisher({ channel, codec: "msgpack", maxRateHz: 30 });
const rec = new StateReceiver({ channel, codec: "msgpack", onState: ... });
```

Install peer `@msgpack/msgpack` when using that codec. JSON remains the default.

Session `backend_opts` for game rooms often include `state_coalesce: true` next to
`rpc_router: true`.

## Presence / feeds / talking

Wire callbacks on `XylonRoom` (or `ControlSignaling`):

```ts
room.onPresenceSnapshot = (frame) => console.log(frame.participants);
room.onPresenceDiff = (frame) => console.log(frame.action, frame.participant_id);

room.onFeedsSnapshot = (frame) => console.log(frame.publishers);
room.onFeedsDiff = (frame) => console.log(frame.action, frame.participant_id, frame.kinds);

room.onTalking = (frame) => {
  // layout only -- never auto-subscribe from levels
  console.log(frame.type, frame.participant_id, frame.audio_level_dbov_avg);
};
```

Direct **Xylon Control edge** REST (lab / Bearer against the edge). Product apps
that route admin through a customer backend should use `AdminClient` instead:

```ts
import { fetchPresence, fetchHistory } from "xylon-client-sdk";

const presence = await fetchPresence("https://edge.example", {
  token,
  tenantId: "acme",
  sessionId: "room-1"
});
```

## Conference subscribe (manual)

With `library: "conference"` and `backendOpts: { subscribe_mode: "manual" }`, listen
to feeds then call:

```ts
await room.subscribe({ publisherId: "alice", kind: "audio" });
await room.subscribe({ publisherId: "alice", kind: "video", substream: 1 });
await room.switch({ publisherId: "bob", kind: "video" });
await room.unsubscribe({ publisherId: "alice", kind: "audio" });
```

Same methods exist on `ControlSignaling`. Recipe:
[xylon-conference-backend README](https://github.com/Lazarus404/xylon_conference_backend) "App path
(manual)".

## Out of scope (v1)

Auto-reconnect, SIP, HTTP JSEP primary path, Control-WS inject frames,
Sync/CRDT, MFU codecs, WS `pause`/`resume` (Elixir Plan pause only today).
Customer-admin login UI (use `prepareRequest` / cookies on `AdminClient`).
