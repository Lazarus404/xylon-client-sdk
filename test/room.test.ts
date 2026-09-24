import { describe, expect, it, vi } from "vitest";
import { XylonRoom, waitIceGatheringComplete } from "../src/room.js";
import { FakeWebSocket } from "./fake_ws.js";
import { FakeRTCPeerConnection, FakeRtpSender, FakeRtpTransceiver } from "./fake_pc.js";

function installWs(
  autoReply: (frame: Record<string, unknown>) => Record<string, unknown> | null
): typeof WebSocket {
  return class extends FakeWebSocket {
    constructor(url: string) {
      super(url);
      this.autoReply = autoReply;
    }
  } as unknown as typeof WebSocket;
}

describe("XylonRoom", () => {
  it("waitIceGatheringComplete resolves when gathering finishes", async () => {
    const pc = new FakeRTCPeerConnection();
    pc.iceGatheringState = "gathering";
    const done = waitIceGatheringComplete(pc as unknown as RTCPeerConnection, 2000);
    queueMicrotask(() => {
      pc.iceGatheringState = "complete";
      pc.onicegatheringstatechange?.();
    });
    await done;
    expect(pc.iceGatheringState).toBe("complete");
  });

  it("connect posts offer only after ICE gathering is complete", async () => {
    let offerAtMs = 0;
    let gatherDoneAtMs = 0;
    class SlowGatherPC extends FakeRTCPeerConnection {
      async setLocalDescription(desc: { type: string; sdp: string }): Promise<void> {
        this.localDescription = desc;
        this.iceGatheringState = "gathering";
        setTimeout(() => {
          gatherDoneAtMs = Date.now();
          this.iceGatheringState = "complete";
          this.onicegatheringstatechange?.();
        }, 40);
      }
    }

    const WebSocketImpl = class extends FakeWebSocket {
      constructor(url: string) {
        super(url);
        this.autoReply = (frame) => {
          if (frame.type === "join") return { type: "joined", session_id: "room-ice" };
          if (frame.type === "offer") {
            offerAtMs = Date.now();
            return { type: "answer", sdp: "v=0\r\nanswer" };
          }
          if (frame.type === "ice") return { type: "ice_ok" };
          return null;
        };
      }
    } as unknown as typeof WebSocket;

    const room = new XylonRoom();
    await room.connect({
      wsUrl: "ws://test/v1/ws",
      token: "tok",
      library: "datachannel",
      dataChannelLabels: ["chat"],
      WebSocketImpl,
      RTCPeerConnectionImpl: SlowGatherPC as unknown as typeof RTCPeerConnection
    });
    expect(gatherDoneAtMs).toBeGreaterThan(0);
    expect(offerAtMs).toBeGreaterThanOrEqual(gatherDoneAtMs);
    room.close();
  });

  it("connect: join, offer/answer, trickle ice", async () => {
    let lastWs: FakeWebSocket | null = null;
    const WebSocketImpl = class extends FakeWebSocket {
      constructor(url: string) {
        super(url);
        lastWs = this;
        this.autoReply = (frame) => {
          if (frame.type === "join") return { type: "joined", session_id: "room-1" };
          if (frame.type === "offer") return { type: "answer", sdp: "v=0\r\nanswer" };
          if (frame.type === "ice") return { type: "ice_ok" };
          return null;
        };
      }
    } as unknown as typeof WebSocket;

    const room = new XylonRoom();
    const states: string[] = [];
    room.onconnectionstatechange = (s) => states.push(s);

    await room.connect({
      wsUrl: "ws://test/v1/ws",
      token: "tok",
      library: "datachannel",
      dataChannelLabels: ["chat"],
      WebSocketImpl,
      RTCPeerConnectionImpl: FakeRTCPeerConnection as unknown as typeof RTCPeerConnection
    });

    expect(room.sessionId).toBe("room-1");
    expect(room.peerConnection).toBeInstanceOf(FakeRTCPeerConnection);
    const pc = room.peerConnection as unknown as FakeRTCPeerConnection;
    expect(pc.createdLabels).toContain("chat");
    expect(pc.remoteDescription?.sdp).toBe("v=0\r\nanswer");
    expect(states).toContain("connected");

    const types = lastWs!.sent.map((s) => JSON.parse(s).type);
    expect(types).toContain("join");
    expect(types).toContain("offer");
    expect(types).toContain("ice");

    room.close();
  });

  it("connect adds mediaStream tracks before offer", async () => {
    const WebSocketImpl = installWs((frame) => {
      if (frame.type === "join") return { type: "joined", session_id: "r1" };
      if (frame.type === "offer") return { type: "answer", sdp: "v=0\r\na" };
      if (frame.type === "ice") return { type: "ice_ok" };
      return null;
    });

    const stream = {
      getTracks: () => [{ kind: "audio" }, { kind: "video" }]
    } as unknown as MediaStream;

    const room = new XylonRoom();
    await room.connect({
      wsUrl: "ws://test/v1/ws",
      token: "tok",
      library: "conference",
      mediaStream: stream,
      WebSocketImpl,
      RTCPeerConnectionImpl: FakeRTCPeerConnection as unknown as typeof RTCPeerConnection
    });

    const pc = room.peerConnection as unknown as FakeRTCPeerConnection;
    expect(pc.addedTracks.map((t) => t.track.kind)).toEqual(["audio", "video"]);
    room.close();
  });

  it("opens state label with unreliable DCEP defaults", async () => {
    const WebSocketImpl = installWs((frame) => {
      if (frame.type === "join") return { type: "joined", session_id: "r1" };
      if (frame.type === "offer") return { type: "answer", sdp: "v=0\r\na" };
      if (frame.type === "ice") return { type: "ice_ok" };
      return null;
    });

    const room = new XylonRoom();
    await room.connect({
      wsUrl: "ws://test/v1/ws",
      token: "tok",
      dataChannelLabels: ["chat", "state"],
      WebSocketImpl,
      RTCPeerConnectionImpl: FakeRTCPeerConnection as unknown as typeof RTCPeerConnection
    });

    const pc = room.peerConnection as unknown as FakeRTCPeerConnection;
    const stateInit = pc.createdInits.find((x) => x.label === "state")?.init;
    const chatInit = pc.createdInits.find((x) => x.label === "chat")?.init;
    expect(stateInit).toMatchObject({ ordered: false, maxRetransmits: 0 });
    expect(chatInit).toMatchObject({ ordered: true });
    room.close();
  });

  it("createDataChannel after connect delegates to PC", async () => {
    const WebSocketImpl = installWs((frame) => {
      if (frame.type === "join") return { type: "joined", session_id: "r1" };
      if (frame.type === "offer") return { type: "answer", sdp: "v=0\r\na" };
      if (frame.type === "ice") return { type: "ice_ok" };
      return null;
    });

    const room = new XylonRoom();
    await room.connect({
      wsUrl: "ws://test/v1/ws",
      token: "tok",
      sessionId: "r1",
      tenantId: "t1",
      WebSocketImpl,
      RTCPeerConnectionImpl: FakeRTCPeerConnection as unknown as typeof RTCPeerConnection
    });

    const dc = room.createDataChannel("late");
    expect(dc.label).toBe("late");
    expect(room.dataChannel("late")).toBe(dc);
    room.close();
  });

  it("getToken supplies join token (wins over token)", async () => {
    let joinedToken: string | undefined;
    const WebSocketImpl = installWs((frame) => {
      if (frame.type === "join") {
        joinedToken = frame.token as string | undefined;
        return { type: "joined", session_id: "r1" };
      }
      if (frame.type === "offer") return { type: "answer", sdp: "v=0\r\na" };
      if (frame.type === "ice") return { type: "ice_ok" };
      return null;
    });

    const room = new XylonRoom();
    await room.connect({
      wsUrl: "ws://test/v1/ws",
      token: "ignored",
      getToken: async () => "from-host",
      WebSocketImpl,
      RTCPeerConnectionImpl: FakeRTCPeerConnection as unknown as typeof RTCPeerConnection
    });

    expect(joinedToken).toBe("from-host");
    room.close();
  });

  it("post-connect ICE awaits ice_ok on the serial queue", async () => {
    let iceCount = 0;
    const WebSocketImpl = installWs((frame) => {
      if (frame.type === "join") return { type: "joined", session_id: "r1" };
      if (frame.type === "offer") return { type: "answer", sdp: "v=0\r\na" };
      if (frame.type === "ice") {
        iceCount += 1;
        return { type: "ice_ok" };
      }
      return null;
    });

    const room = new XylonRoom();
    await room.connect({
      wsUrl: "ws://test/v1/ws",
      token: "tok",
      WebSocketImpl,
      RTCPeerConnectionImpl: FakeRTCPeerConnection as unknown as typeof RTCPeerConnection
    });

    const before = iceCount;
    const pc = room.peerConnection as unknown as FakeRTCPeerConnection;
    pc.onicecandidate?.({
      candidate: {
        candidate: "candidate:9 1 UDP 1 10.0.0.1 9 typ host",
        sdpMid: "0",
        sdpMLineIndex: 0
      }
    });
    await vi.waitFor(() => expect(iceCount).toBeGreaterThan(before));
    room.close();
  });

  it("empty-string onicecandidate is end-of-candidates (Firefox)", async () => {
    const iceFrames: Record<string, unknown>[] = [];
    const WebSocketImpl = installWs((frame) => {
      if (frame.type === "join") return { type: "joined", session_id: "r1" };
      if (frame.type === "offer") return { type: "answer", sdp: "v=0\r\na" };
      if (frame.type === "ice") {
        iceFrames.push(frame);
        return { type: "ice_ok" };
      }
      return null;
    });

    const room = new XylonRoom();
    await room.connect({
      wsUrl: "ws://test/v1/ws",
      token: "tok",
      WebSocketImpl,
      RTCPeerConnectionImpl: FakeRTCPeerConnection as unknown as typeof RTCPeerConnection
    });

    const before = iceFrames.length;
    const pc = room.peerConnection as unknown as FakeRTCPeerConnection;
    pc.onicecandidate?.({
      candidate: {
        candidate: "",
        sdpMid: "1",
        sdpMLineIndex: 1
      }
    });
    await vi.waitFor(() => expect(iceFrames.length).toBeGreaterThan(before));

    const eoc = iceFrames[iceFrames.length - 1]!;
    expect(eoc).toMatchObject({
      type: "ice",
      candidate: null,
      sdpMid: "1",
      end_of_candidates: true
    });
    expect(eoc.candidate).not.toBe("");
    room.close();
  });

  it("applies unsolicited server ice via addIceCandidate", async () => {
    let lastWs: FakeWebSocket | null = null;
    const WebSocketImpl = class extends FakeWebSocket {
      constructor(url: string) {
        super(url);
        lastWs = this;
        this.autoReply = (frame) => {
          if (frame.type === "join") return { type: "joined", session_id: "r1" };
          if (frame.type === "offer") {
            queueMicrotask(() => {
              this.reply({
                type: "ice",
                candidate: "candidate:9 1 UDP 1 203.0.113.5 9 typ srflx",
                sdpMid: "0",
                sdpMLineIndex: 0
              });
              this.reply({ type: "ice_complete" });
            });
            return { type: "answer", sdp: "v=0\r\nanswer" };
          }
          if (frame.type === "ice") return { type: "ice_ok" };
          return null;
        };
      }
    } as unknown as typeof WebSocket;

    const room = new XylonRoom();
    await room.connect({
      wsUrl: "ws://test/v1/ws",
      token: "tok",
      WebSocketImpl,
      RTCPeerConnectionImpl: FakeRTCPeerConnection as unknown as typeof RTCPeerConnection
    });

    const pc = room.peerConnection as unknown as FakeRTCPeerConnection;
    await vi.waitFor(() =>
      expect(pc.addedRemoteCandidates.some((c) => c.candidate?.includes("203.0.113.5"))).toBe(
        true
      )
    );
    expect(lastWs).not.toBeNull();
    room.close();
  });

  it("publish_layers scopes setParameters to matching mid only", async () => {
    let lastWs: FakeWebSocket | null = null;
    const WebSocketImpl = class extends FakeWebSocket {
      constructor(url: string) {
        super(url);
        lastWs = this;
        this.autoReply = (frame) => {
          if (frame.type === "join") return { type: "joined", session_id: "r1" };
          if (frame.type === "offer") return { type: "answer", sdp: "v=0\r\na" };
          if (frame.type === "ice") return { type: "ice_ok" };
          return null;
        };
      }
    } as unknown as typeof WebSocket;

    const room = new XylonRoom();
    await room.connect({
      wsUrl: "ws://test/v1/ws",
      token: "tok",
      library: "conference",
      WebSocketImpl,
      RTCPeerConnectionImpl: FakeRTCPeerConnection as unknown as typeof RTCPeerConnection
    });

    const pc = room.peerConnection as unknown as FakeRTCPeerConnection;
    const cam1 = new FakeRtpSender({ kind: "video" }, [
      { rid: "q", active: true },
      { rid: "h", active: true }
    ]);
    const cam2 = new FakeRtpSender({ kind: "video" }, [
      { rid: "q", active: true },
      { rid: "h", active: true }
    ]);
    pc.transceivers = [
      new FakeRtpTransceiver("1", cam1),
      new FakeRtpTransceiver("2", cam2)
    ];

    lastWs!.reply({
      type: "publish_layers",
      mid: "1",
      layers: [
        { rid: "q", active: true },
        { rid: "h", active: false }
      ]
    });

    await vi.waitFor(() => expect(cam1.setParametersCalls).toBe(1));
    expect(cam1.encodings).toEqual([
      { rid: "q", active: true },
      { rid: "h", active: false }
    ]);
    expect(cam2.setParametersCalls).toBe(0);
    expect(cam2.encodings).toEqual([
      { rid: "q", active: true },
      { rid: "h", active: true }
    ]);
    room.close();
  });

  it("send with dest sets envelope to on the datachannel", async () => {
    const WebSocketImpl = installWs((frame) => {
      if (frame.type === "join") return { type: "joined", session_id: "room-dest" };
      if (frame.type === "offer") return { type: "answer", sdp: "v=0\r\nanswer" };
      if (frame.type === "ice") return { type: "ice_ok" };
      return null;
    });

    const room = new XylonRoom();
    await room.connect({
      wsUrl: "ws://test/v1/ws",
      token: "tok",
      library: "datachannel",
      dataChannelLabels: ["chat"],
      WebSocketImpl,
      RTCPeerConnectionImpl: FakeRTCPeerConnection as unknown as typeof RTCPeerConnection
    });

    room.send("chat", { type: "chat", text: "hi" }, { dest: ["bob", "carol"] });
    const dc = room.dataChannel("chat") as unknown as { sent: string[] };
    expect(dc.sent).toHaveLength(1);
    expect(JSON.parse(dc.sent[0]!)).toEqual({
      type: "chat",
      text: "hi",
      to: ["bob", "carol"]
    });

    room.close();
  });

  it("reconnect closes then connects with fresh getToken", async () => {
    let tokens = 0;
    const WebSocketImpl = installWs((frame) => {
      if (frame.type === "join") return { type: "joined", session_id: "r-re" };
      if (frame.type === "offer") return { type: "answer", sdp: "v=0\r\na" };
      if (frame.type === "ice") return { type: "ice_ok" };
      return null;
    });

    const room = new XylonRoom();
    const opts = {
      wsUrl: "ws://test/v1/ws",
      getToken: async () => {
        tokens += 1;
        return `tok-${tokens}`;
      },
      library: "datachannel",
      WebSocketImpl,
      RTCPeerConnectionImpl: FakeRTCPeerConnection as unknown as typeof RTCPeerConnection
    };

    await room.connect(opts);
    expect(tokens).toBe(1);
    const firstPc = room.peerConnection;

    await room.reconnect(opts);
    expect(tokens).toBe(2);
    expect(room.peerConnection).not.toBe(firstPc);
    expect(room.sessionId).toBe("r-re");
    room.close();
  });
});
