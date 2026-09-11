import { describe, expect, it, vi } from "vitest";
import { RpcClient, RpcError, createRpcClient } from "../src/rpc.js";
import { CHAT_LABEL, GAME_DATA_CHANNEL_LABELS, RPC_LABEL } from "../src/labels.js";

class FakeDc {
  label: string;
  readyState = "open";
  sent: string[] = [];
  private listeners = new Set<(ev: { data: unknown }) => void>();

  constructor(label = RPC_LABEL) {
    this.label = label;
  }

  send(data: string): void {
    this.sent.push(data);
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

  deliver(data: string): void {
    for (const l of this.listeners) l({ data });
  }
}

describe("labels", () => {
  it("exports game labels", () => {
    expect(CHAT_LABEL).toBe("chat");
    expect(RPC_LABEL).toBe("rpc");
    expect(GAME_DATA_CHANNEL_LABELS).toContain("state");
  });
});

describe("RpcClient", () => {
  it("performRpc resolves on rpc.res", async () => {
    const dc = new FakeDc();
    const client = new RpcClient({ localParticipantId: "a", channel: dc });
    const p = client.performRpc("b", "ping", { n: 1 }, { timeoutMs: 1000 });
    expect(dc.sent).toHaveLength(1);
    const req = JSON.parse(dc.sent[0]!);
    expect(req.type).toBe("rpc.req");
    expect(req.to).toBe("b");
    dc.deliver(JSON.stringify({ type: "rpc.res", id: req.id, payload: { ok: true } }));
    await expect(p).resolves.toEqual({ ok: true });
    client.close();
  });

  it("performRpc rejects on rpc.err and timeout", async () => {
    const dc = new FakeDc();
    const client = new RpcClient({ localParticipantId: "a", channel: dc });
    const p = client.performRpc("b", "x", null, { timeoutMs: 1000 });
    const req = JSON.parse(dc.sent[0]!);
    dc.deliver(
      JSON.stringify({
        type: "rpc.err",
        id: req.id,
        code: "not_found",
        message: "nope"
      })
    );
    await expect(p).rejects.toMatchObject({ code: "not_found", name: "RpcError" });

    vi.useFakeTimers();
    const p2 = client.performRpc("b", "y", null, { timeoutMs: 50 });
    vi.advanceTimersByTime(60);
    await expect(p2).rejects.toBeInstanceOf(RpcError);
    vi.useRealTimers();
    client.close();
  });

  it("handles inbound rpc.req and ignores wrong to", async () => {
    const dc = new FakeDc();
    const client = new RpcClient({ localParticipantId: "b", channel: dc });
    client.registerRpcMethod("ping", (payload) => ({ echo: payload }));

    dc.deliver(
      JSON.stringify({
        type: "rpc.req",
        id: "1",
        method: "ping",
        to: "other",
        from: "a",
        payload: 1
      })
    );
    expect(dc.sent).toHaveLength(0);

    dc.deliver(
      JSON.stringify({
        type: "rpc.req",
        id: "2",
        method: "ping",
        to: "b",
        from: "a",
        payload: { x: 1 }
      })
    );
    await vi.waitFor(() => expect(dc.sent.length).toBe(1));
    const res = JSON.parse(dc.sent[0]!);
    expect(res.type).toBe("rpc.res");
    expect(res.payload).toEqual({ echo: { x: 1 } });
    client.close();
  });

  it("createRpcClient uses getChannel", () => {
    const dc = new FakeDc();
    const client = createRpcClient({
      localParticipantId: "a",
      getChannel: (label) => (label === RPC_LABEL ? dc : null)
    });
    expect(client.localParticipantId).toBe("a");
    client.close();
  });
});
