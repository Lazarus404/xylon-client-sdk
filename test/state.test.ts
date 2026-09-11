import { describe, expect, it, vi, beforeAll } from "vitest";
import { encode as msgpackEncode, decode as msgpackDecode } from "@msgpack/msgpack";
import {
  StatePublisher,
  StateReceiver,
  createStatePair,
  ensureMsgpackCodec
} from "../src/state.js";
import { STATE_LABEL, STATE_CHANNEL_INIT } from "../src/labels.js";

class FakeDc {
  label = STATE_LABEL;
  readyState = "open";
  sent: Array<string | Uint8Array> = [];
  private listeners = new Set<(ev: { data: unknown }) => void>();

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (typeof data === "string") this.sent.push(data);
    else if (data instanceof Uint8Array) this.sent.push(data);
    else if (ArrayBuffer.isView(data)) {
      const view = data as ArrayBufferView;
      this.sent.push(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
    } else if (data instanceof ArrayBuffer) this.sent.push(new Uint8Array(data));
  }

  addEventListener(_type: "message", listener: (ev: { data: unknown }) => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(
    _type: "message",
    listener: (ev: { data: unknown }) => void
  ): void {
    this.listeners.delete(listener);
  }

  deliver(data: unknown): void {
    for (const l of this.listeners) l({ data });
  }
}

describe("StatePublisher", () => {
  it("increments seq per topic", () => {
    const dc = new FakeDc();
    const pub = new StatePublisher({ channel: dc });
    expect(pub.publish("transform", { x: 1 })).toBe(true);
    expect(pub.publish("transform", { x: 2 })).toBe(true);
    expect(pub.publish("health", { hp: 1 })).toBe(true);
    expect(pub.seq("transform")).toBe(2);
    expect(pub.seq("health")).toBe(1);
    const a = JSON.parse(dc.sent[0]! as string);
    const b = JSON.parse(dc.sent[1]! as string);
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(a.type).toBe("state");
    pub.close();
  });

  it("throttles and keeps latest pending", async () => {
    vi.useFakeTimers();
    const dc = new FakeDc();
    const pub = new StatePublisher({ channel: dc, maxRateHz: 10 });
    expect(pub.publish("t", { n: 1 })).toBe(true);
    expect(pub.publish("t", { n: 2 })).toBe(false);
    expect(pub.publish("t", { n: 3 })).toBe(false);
    expect(dc.sent).toHaveLength(1);
    vi.advanceTimersByTime(100);
    expect(dc.sent).toHaveLength(2);
    const last = JSON.parse(dc.sent[1]! as string);
    expect(last.body).toEqual({ n: 3 });
    expect(last.seq).toBe(3);
    vi.useRealTimers();
    pub.close();
  });
});

describe("StateReceiver", () => {
  it("accepts increasing seq and drops stale per sender", () => {
    const dc = new FakeDc();
    const events: { topic: string; seq: number; senderId: string }[] = [];
    const rec = new StateReceiver({
      channel: dc,
      onState: (topic, _body, meta) => {
        events.push({ topic, seq: meta.seq, senderId: meta.senderId });
      }
    });

    dc.deliver(
      JSON.stringify({
        type: "state",
        topic: "transform",
        seq: 1,
        from: "a",
        body: { x: 0 }
      })
    );
    dc.deliver(
      JSON.stringify({
        type: "state",
        topic: "transform",
        seq: 1,
        from: "a",
        body: { x: 1 }
      })
    );
    dc.deliver(
      JSON.stringify({
        type: "state",
        topic: "transform",
        seq: 2,
        from: "a",
        body: { x: 2 }
      })
    );
    dc.deliver(
      JSON.stringify({
        type: "state",
        topic: "transform",
        seq: 1,
        from: "b",
        body: { x: 9 }
      })
    );

    expect(events).toEqual([
      { topic: "transform", seq: 1, senderId: "a" },
      { topic: "transform", seq: 2, senderId: "a" },
      { topic: "transform", seq: 1, senderId: "b" }
    ]);
    expect(rec.accepted).toBe(3);
    expect(rec.dropped).toBe(1);
    rec.close();
  });
});

describe("msgpack codec", () => {
  beforeAll(async () => {
    await ensureMsgpackCodec();
  });

  it("round-trips state ticks as binary", () => {
    const dc = new FakeDc();
    const events: { topic: string; body: unknown }[] = [];
    const pub = new StatePublisher({ channel: dc, codec: "msgpack" });
    const rec = new StateReceiver({
      channel: dc,
      codec: "msgpack",
      onState: (topic, body) => events.push({ topic, body })
    });

    expect(pub.publish("player", { x: 1 })).toBe(true);
    const wire = dc.sent[0]!;
    expect(wire).toBeInstanceOf(Uint8Array);
    const decoded = msgpackDecode(wire as Uint8Array) as Record<string, unknown>;
    expect(decoded.type).toBe("state");
    expect(decoded.topic).toBe("player");

    dc.deliver(wire);
    expect(events).toEqual([{ topic: "player", body: { x: 1 } }]);
    rec.close();
    pub.close();
  });

  it("encode fixture matches @msgpack/msgpack", () => {
    const expected = msgpackEncode({
      type: "state",
      topic: "t",
      seq: 1,
      t: 1,
      body: {}
    });
    expect(expected.byteLength).toBeGreaterThan(0);
  });
});

describe("createStatePair", () => {
  it("binds publisher and receiver to state label", () => {
    const dc = new FakeDc();
    const { publisher, receiver } = createStatePair({
      getChannel: (l) => (l === STATE_LABEL ? dc : null),
      onState: () => {}
    });
    expect(publisher.publish("t", {})).toBe(true);
    receiver.close();
    publisher.close();
  });

  it("createChannel receives unreliable state init", () => {
    let seen: RTCDataChannelInit | undefined;
    const dc = new FakeDc();
    createStatePair({
      getChannel: () => null,
      createChannel: (_label, init) => {
        seen = init;
        return dc;
      },
      onState: () => {}
    });
    expect(seen).toEqual(STATE_CHANNEL_INIT);
  });
});
