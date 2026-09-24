import { describe, expect, it, vi, afterEach } from "vitest";
import { fetchHistory, fetchPresence, resolveDest } from "../src/rest.js";
import { sendResolvedJson } from "../src/send.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("rest helpers", () => {
  it("fetchPresence sends Bearer and path", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ participants: [] })
    }));
    vi.stubGlobal("fetch", fetchMock);

    const data = await fetchPresence("https://edge.example/", {
      token: "tok",
      tenantId: "acme",
      sessionId: "room-1"
    });

    expect(data).toEqual({ participants: [] });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://edge.example/v1/tenants/acme/sessions/room-1/presence");
    expect(init).toMatchObject({
      method: "GET",
      headers: { authorization: "Bearer tok" }
    });
  });

  it("fetchHistory includes label query", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ messages: [] })
    }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchHistory("https://edge.example", {
      token: "tok",
      tenantId: "acme",
      sessionId: "room-1",
      label: "chat"
    });

    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      "https://edge.example/v1/tenants/acme/sessions/room-1/history?label=chat"
    );
  });

  it("resolveDest posts group filter", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, dest: ["a", "b"] })
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await resolveDest(
      "https://edge.example",
      {
        token: "tok",
        tenantId: "acme",
        sessionId: "room-1",
        participantId: "self"
      },
      { group: "breakout" }
    );

    expect(result).toEqual({ ok: true, dest: ["a", "b"] });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      "https://edge.example/v1/tenants/acme/sessions/room-1/dest/resolve"
    );
    expect(init).toMatchObject({ method: "POST" });
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      dest: { group: "breakout" },
      participant_id: "self"
    });
  });

  it("throws on non-OK", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 401,
        text: async () => "missing or invalid bearer token"
      }))
    );

    await expect(
      fetchPresence("https://edge.example", {
        token: "bad",
        tenantId: "acme",
        sessionId: "room-1"
      })
    ).rejects.toThrow(/401/);
  });
});

describe("sendResolvedJson", () => {
  it("sets to for id list and omits for all", () => {
    const sent: string[] = [];
    const ch = {
      readyState: "open",
      send: (s: string) => sent.push(s)
    };
    void sendResolvedJson(ch, { type: "chat", text: "x" }, ["b", "c"]);
    expect(JSON.parse(sent[0]!)).toEqual({
      type: "chat",
      text: "x",
      to: ["b", "c"]
    });
    void sendResolvedJson(ch, { type: "chat", text: "y" }, "all");
    expect(JSON.parse(sent[1]!)).toEqual({ type: "chat", text: "y" });
  });
});
