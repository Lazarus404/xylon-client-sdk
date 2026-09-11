import { describe, expect, it, vi, afterEach } from "vitest";
import { fetchHistory, fetchPresence } from "../src/rest.js";

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
