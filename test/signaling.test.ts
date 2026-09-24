import { describe, expect, it } from "vitest";
import { ControlSignaling, SignalingError } from "../src/signaling.js";
import { FakeWebSocket } from "./fake_ws.js";

describe("ControlSignaling", () => {
  it("sends join and resolves on joined", async () => {
    const ws = new FakeWebSocket("ws://test/v1/ws");
    const sig = new ControlSignaling(ws);
    await ws.waitOpen();

    const joinP = sig.join({
      token: "tok",
      library: "datachannel",
      tenantId: "acme",
      sessionId: "room-1",
      participantId: "a"
    });

    expect(JSON.parse(ws.sent[0]!)).toMatchObject({
      type: "join",
      token: "tok",
      library: "datachannel",
      tenant_id: "acme",
      session_id: "room-1",
      participant_id: "a"
    });

    ws.reply({ type: "joined", session_id: "room-1" });
    await expect(joinP).resolves.toEqual({ sessionId: "room-1" });
  });

  it("sends backend_opts on join", async () => {
    const ws = new FakeWebSocket("ws://test/v1/ws");
    const sig = new ControlSignaling(ws);
    await ws.waitOpen();

    const joinP = sig.join({
      token: "tok",
      sessionId: "r1",
      tenantId: "t1",
      backendOpts: { mode: "fanout_all", default_label: "chat" }
    });
    expect(JSON.parse(ws.sent[0]!)).toMatchObject({
      type: "join",
      backend_opts: { mode: "fanout_all", default_label: "chat" }
    });
    ws.reply({ type: "joined", session_id: "r1" });
    await joinP;
  });

  it("rejects join on error frame", async () => {
    const ws = new FakeWebSocket("ws://test/v1/ws");
    const sig = new ControlSignaling(ws);
    await ws.waitOpen();

    const joinP = sig.join({ token: "bad" });
    ws.reply({ type: "error", reason: "unauthorized" });
    await expect(joinP).rejects.toMatchObject({
      name: "SignalingError",
      reason: "unauthorized"
    });
    expect(SignalingError).toBeDefined();
  });


  it("sends offer and resolves answer sdp", async () => {
    const ws = new FakeWebSocket("ws://test/v1/ws");
    const sig = new ControlSignaling(ws);
    await ws.waitOpen();

    const offerP = sig.offer("v=0\r\noffer");
    expect(JSON.parse(ws.sent[0]!)).toEqual({ type: "offer", sdp: "v=0\r\noffer" });
    ws.reply({ type: "answer", sdp: "v=0\r\nanswer" });
    await expect(offerP).resolves.toEqual({ sdp: "v=0\r\nanswer" });
  });

  it("sends ice and resolves on ice_ok", async () => {
    const ws = new FakeWebSocket("ws://test/v1/ws");
    const sig = new ControlSignaling(ws);
    await ws.waitOpen();

    const iceP = sig.ice({
      candidate: "candidate:1 1 UDP 1 1.2.3.4 9 typ host",
      sdpMid: "0",
      sdpMLineIndex: 0
    });
    expect(JSON.parse(ws.sent[0]!)).toEqual({
      type: "ice",
      candidate: "candidate:1 1 UDP 1 1.2.3.4 9 typ host",
      sdpMid: "0",
      sdpMLineIndex: 0
    });
    ws.reply({ type: "ice_ok" });
    await expect(iceP).resolves.toBeUndefined();
  });

  it("sends null candidate for end of candidates", async () => {
    const ws = new FakeWebSocket("ws://test/v1/ws");
    const sig = new ControlSignaling(ws);
    await ws.waitOpen();

    const iceP = sig.ice({ candidate: null, sdpMid: "0", endOfCandidates: true });
    expect(JSON.parse(ws.sent[0]!)).toMatchObject({
      type: "ice",
      candidate: null,
      sdpMid: "0",
      end_of_candidates: true
    });
    ws.reply({ type: "ice_ok" });
    await iceP;
  });

  it("dispatches unsolicited server ice without resolving ice_ok", async () => {
    const ws = new FakeWebSocket("ws://test/v1/ws");
    const sig = new ControlSignaling(ws);
    await ws.waitOpen();

    const serverIce: unknown[] = [];
    let complete = 0;
    sig.onServerIce = (f) => serverIce.push(f);
    sig.onServerIceComplete = () => {
      complete += 1;
    };

    const iceP = sig.ice({
      candidate: "candidate:1 1 UDP 1 1.2.3.4 9 typ host",
      sdpMid: "0"
    });

    ws.reply({
      type: "ice",
      candidate: "candidate:9 1 UDP 1 203.0.113.1 9 typ srflx",
      sdpMid: "0",
      sdpMLineIndex: 0
    });
    ws.reply({ type: "ice_complete" });
    expect(serverIce).toHaveLength(1);
    expect(complete).toBe(1);

    ws.reply({ type: "ice_ok" });
    await expect(iceP).resolves.toBeUndefined();
  });

  it("dispatches groups snapshot and diff frames", async () => {
    const ws = new FakeWebSocket("ws://test/v1/ws");
    const sig = new ControlSignaling(ws);
    await ws.waitOpen();

    const snapshots: unknown[] = [];
    const diffs: unknown[] = [];
    sig.onGroupsSnapshot = (f) => snapshots.push(f);
    sig.onGroupsDiff = (f) => diffs.push(f);

    ws.reply({
      type: "groups.snapshot",
      groups: { breakout: ["a", "b"] }
    });
    expect(snapshots).toEqual([
      { type: "groups.snapshot", groups: { breakout: ["a", "b"] } }
    ]);

    ws.reply({
      type: "groups.diff",
      action: "add_member",
      group_id: "breakout",
      participant_id: "c"
    });
    expect(diffs).toEqual([
      {
        type: "groups.diff",
        action: "add_member",
        group_id: "breakout",
        participant_id: "c"
      }
    ]);
  });

  it("dispatches presence frames without stealing joined", async () => {
    const ws = new FakeWebSocket("ws://test/v1/ws");
    const sig = new ControlSignaling(ws);
    await ws.waitOpen();

    const snapshots: unknown[] = [];
    const diffs: unknown[] = [];
    sig.onPresenceSnapshot = (f) => snapshots.push(f);
    sig.onPresenceDiff = (f) => diffs.push(f);

    const joinP = sig.join({
      token: "tok",
      tenantId: "t1",
      sessionId: "r1",
      participantId: "a"
    });

    ws.reply({ type: "joined", session_id: "r1" });
    ws.reply({
      type: "presence.snapshot",
      participants: { b: { role: "member", joined_at: 1, meta: {} } }
    });
    await expect(joinP).resolves.toEqual({ sessionId: "r1" });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      type: "presence.snapshot",
      participants: { b: { role: "member" } }
    });

    ws.reply({
      type: "presence.diff",
      action: "join",
      participant_id: "a",
      role: "member",
      joined_at: 2
    });
    ws.reply({
      type: "presence.diff",
      action: "leave",
      participant_id: "b"
    });
    expect(diffs).toHaveLength(2);
    expect(diffs[0]).toMatchObject({ action: "join", participant_id: "a" });
    expect(diffs[1]).toMatchObject({ action: "leave", participant_id: "b" });
  });

  it("dispatches feeds and talking without stealing joined", async () => {
    const ws = new FakeWebSocket("ws://test/v1/ws");
    const sig = new ControlSignaling(ws);
    await ws.waitOpen();

    const feeds: unknown[] = [];
    const talking: unknown[] = [];
    sig.onFeedsSnapshot = (f) => feeds.push(f);
    sig.onFeedsDiff = (f) => feeds.push(f);
    sig.onTalking = (f) => talking.push(f);

    const joinP = sig.join({ token: "tok", sessionId: "r1", tenantId: "t1" });
    ws.reply({ type: "joined", session_id: "r1" });
    ws.reply({
      type: "feeds.snapshot",
      publishers: [{ participant_id: "a", kinds: ["audio"] }]
    });
    await joinP;

    expect(feeds).toHaveLength(1);
    ws.reply({
      type: "feeds.diff",
      action: "published",
      participant_id: "b",
      kinds: ["video"]
    });
    ws.reply({ type: "talking", participant_id: "a", audio_level_dbov_avg: 10 });
    ws.reply({ type: "stopped-talking", participant_id: "a" });
    expect(feeds).toHaveLength(2);
    expect(talking).toHaveLength(2);
  });

  it("dispatches publish_layers without stealing joined", async () => {
    const ws = new FakeWebSocket("ws://test/v1/ws");
    const sig = new ControlSignaling(ws);
    await ws.waitOpen();

    const layers: unknown[] = [];
    sig.onPublishLayers = (f) => layers.push(f);

    const joinP = sig.join({ token: "tok", sessionId: "r1", tenantId: "t1" });
    ws.reply({ type: "joined", session_id: "r1" });
    await joinP;

    ws.reply({
      type: "publish_layers",
      mid: "1",
      layers: [
        { rid: "q", active: true },
        { rid: "h", active: false }
      ]
    });
    expect(layers).toHaveLength(1);
    expect(layers[0]).toMatchObject({ type: "publish_layers", mid: "1" });
  });

  it("subscribe unsubscribe switch await ack frames", async () => {
    const ws = new FakeWebSocket("ws://test/v1/ws");
    const sig = new ControlSignaling(ws);
    await ws.waitOpen();

    const subP = sig.subscribe({
      publisherId: "a",
      kind: "video",
      substream: 1
    });
    expect(JSON.parse(ws.sent[0]!)).toEqual({
      type: "subscribe",
      publisher_id: "a",
      kind: "video",
      substream: 1
    });
    ws.reply({ type: "subscribed" });
    await expect(subP).resolves.toBeUndefined();

    const unsubP = sig.unsubscribe({ publisherId: "a", kind: "video" });
    ws.reply({ type: "unsubscribed" });
    await unsubP;

    const swP = sig.switch({ publisherId: "c", kind: "audio" });
    expect(JSON.parse(ws.sent[2]!)).toMatchObject({
      type: "switch",
      publisher_id: "c",
      kind: "audio"
    });
    ws.reply({ type: "switched" });
    await swP;

    const layerP = sig.setSubstream({
      publisherId: "a",
      kind: "video",
      mid: "1",
      substream: 0,
      rid: "q"
    });
    expect(JSON.parse(ws.sent[3]!)).toEqual({
      type: "set_substream",
      publisher_id: "a",
      kind: "video",
      mid: "1",
      substream: 0,
      rid: "q"
    });
    ws.reply({ type: "substream_set" });
    await expect(layerP).resolves.toBeUndefined();

    const svcP = sig.setSubstream({
      publisherId: "a",
      kind: "video",
      mid: "1",
      spatialLayer: 1,
      temporalLayer: 0
    });
    expect(JSON.parse(ws.sent[4]!)).toEqual({
      type: "set_substream",
      publisher_id: "a",
      kind: "video",
      mid: "1",
      spatial_layer: 1,
      temporal_layer: 0
    });
    ws.reply({ type: "substream_set" });
    await expect(svcP).resolves.toBeUndefined();
  });
});
