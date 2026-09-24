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

### Targeted send

Set envelope `"to"` to a participant id or id list. The Backend fans out only to
those ids (filters / roles / groups are not valid on the media path -- resolve
them via Control `POST .../dest/resolve` first).

```ts
import { resolveDest, sendJson, sendResolvedJson, XylonRoom } from "xylon-client-sdk";

room.send("chat", { type: "chat", text: "hi" }, { dest: ["bob", "carol"] });
// or:
const chat = room.dataChannel("chat")!;
sendJson(chat, { type: "chat", text: "hi" }, { dest: "bob" });
```

#### Named groups

Control owns group membership (`POST/GET/DELETE .../groups`). Resolve a group to
ids, then send:

```ts
import { resolveDest, sendResolvedJson } from "xylon-client-sdk";

const { dest } = await resolveDest(
  "https://edge.example",
  { token, tenantId: "acme", sessionId: "room-1", participantId: "self" },
  { group: "breakout-a" }
);
sendResolvedJson(chat, { type: "chat", text: "hi team" }, dest);
```

Join also receives `groups.snapshot`; live changes arrive as `groups.diff`
(`room.onGroupsSnapshot` / `room.onGroupsDiff`).

#### Host egress routes

Interest / AOI stays in your app: compute participant ids, then have your admin
backend call Control `PUT .../routes/:sender_id` with `{"dest": ["id", ...]}`
(optional `label`). Clients that omit envelope `"to"` inherit that default.
Per-message `room.send(..., { dest })` still overrides the route. `DELETE` without
`?label=` clears all labels for that sender; with `?label=` clears one row. The
SDK does not mint routes -- host only.

Declare `dataChannelLabels` on connect when channels must appear in the offer SDP.
Opening new labels after connect may require renegotiation that the server does not
support.

`getToken` is preferred over a static `token`. There is no silent auto-reconnect;
call `room.reconnect(opts)` (or `close` + `connect`) with a fresh `getToken` /
`token` after `failed` / `disconnected`. Recreate `RpcClient` / state helpers after
reconnect; in-flight RPC is not preserved. Token TTL must cover the session or
you must reconnect before expiry.

Optional lossy `input` label (`INPUT_LABEL` / `INPUT_CHANNEL_INIT`, same unreliable
init as `state`) is not in `GAME_DATA_CHANNEL_LABELS` -- add it to
`dataChannelLabels` when needed:

```ts
import {
  GAME_DATA_CHANNEL_LABELS,
  INPUT_LABEL,
  XylonRoom
} from "xylon-client-sdk";

await room.connect({
  wsUrl: "wss://edge.example/v1/ws",
  getToken: () => fetchTokenFromYourBackend(),
  library: "datachannel",
  dataChannelLabels: [...GAME_DATA_CHANNEL_LABELS, INPUT_LABEL]
});
```

## RPC (datachannel)

Use labels `chat` / `rpc` / `state` (`GAME_DATA_CHANNEL_LABELS`) and open them in the
offer. Create the Session with `mode: "mfu"` and `rpc_router: true` so the server
delivers `rpc.req` only to `to` (without the router, every peer receives the bytes).
`to` may be a participant id, an id list, or `"*"` (everyone except the caller).
Broadcast/multicast payloads are visible to all destinations; the first `rpc.res` /
`rpc.err` wins.

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
await rpc.performRpc("*", "announce", { msg: "hi" });
await rpc.performRpc(["bob", "carol"], "vote", { choice: 1 });
```

`RpcClient` ignores inbound `rpc.req` unless `to` is the local id, `"*"`, or a list
containing the local id (defense in depth). Call `rpc.close()` when leaving the room.

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
to feeds then call. Optional room opt `adaptive_layers: true` lets subscriber REMB
(and TWCC when present) drive receive-side SIM/SVC layer picks (manual
`substream` / layer opts stay sticky). Optional `dynacast: true` pushes
`publish_layers` so this SDK toggles SIM `encodings[].active` on the local
transceiver whose `mid` matches (Chrome-first; Firefox Soft spot if
`active: false` is ignored). For Chrome SIM/SVC publish, pass
`videoPublish: { simulcast: true }` or `{ scalabilityMode: "L3T3_KEY", codec: "video/VP9" }`
on `connect`:

```ts
await room.subscribe({ publisherId: "alice", kind: "audio" });
await room.subscribe({ publisherId: "alice", kind: "video", substream: 1 });
await room.setSubstream({
  publisherId: "alice",
  kind: "video",
  mid: "1",
  spatialLayer: 1,
  temporalLayer: 0
});
await room.switch({ publisherId: "bob", kind: "video" });
await room.unsubscribe({ publisherId: "alice", kind: "audio" });
```

Same methods exist on `ControlSignaling`. Recipe:
[xylon-conference-backend README](https://github.com/Lazarus404/xylon_conference_backend) "App path
(manual)".

## Out of scope (v1)

Silent auto-reconnect loops, SIP, HTTP JSEP primary path, Control-WS inject frames,
Sync/CRDT, MFU codecs, WS `pause`/`resume` (Elixir Plan pause only today).
Use explicit `XylonRoom.reconnect(opts)` after disconnect. Customer-admin login UI
(use `prepareRequest` / cookies on `AdminClient`).
