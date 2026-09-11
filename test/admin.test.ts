import { describe, expect, it, vi } from "vitest";
import { AdminClient, AdminError } from "../src/admin.js";

describe("AdminClient", () => {
  it("presence hits customer admin path and parses JSON", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ participants: { p1: {} } })
    }));

    const admin = new AdminClient({
      baseUrl: "http://127.0.0.1:8092/",
      fetch: fetchMock as unknown as typeof fetch
    });

    const data = await admin.presence("room-1");
    expect(data).toEqual({ participants: { p1: {} } });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8092/v1/sessions/room-1/presence");
    expect(init).toMatchObject({ method: "GET", credentials: "same-origin" });
  });

  it("prepareRequest can set Authorization", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => "{}"
    }));

    const admin = new AdminClient({
      baseUrl: "http://admin.example",
      fetch: fetchMock as unknown as typeof fetch,
      prepareRequest: ({ headers }) => {
        headers.set("authorization", "Bearer host-session");
      }
    });

    await admin.history("room-1", "chat");
    const [, init] = fetchMock.mock.calls[0]!;
    const headers = init!.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer host-session");
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "http://admin.example/v1/sessions/room-1/history?label=chat"
    );
  });

  it("moderate POSTs JSON body; non-OK throws AdminError", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ error: "feature_denied" })
    }));

    const admin = new AdminClient({
      baseUrl: "http://admin.example",
      fetch: fetchMock as unknown as typeof fetch
    });

    const body = { action: "kick", participant_id: "p2" };
    let err: unknown;
    try {
      await admin.moderate("room-1", body);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AdminError);
    expect(err).toMatchObject({ name: "AdminError", status: 403 });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://admin.example/v1/sessions/room-1/moderate");
    expect(init!.method).toBe("POST");
    expect(init!.body).toBe(JSON.stringify(body));
    const headers = init!.headers as Headers;
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("mintToken POSTs /v1/token and returns token", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ token: "a.b" })
    }));

    const admin = new AdminClient({
      baseUrl: "http://127.0.0.1:8092",
      fetch: fetchMock as unknown as typeof fetch
    });

    const out = await admin.mintToken({
      session_id: "room-1",
      participant_id: "alice",
      capabilities: [],
      ttl_sec: 300
    });
    expect(out).toEqual({ token: "a.b" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8092/v1/token");
    expect(init!.method).toBe("POST");
    expect(JSON.parse(init!.body as string)).toEqual({
      session_id: "room-1",
      participant_id: "alice",
      capabilities: [],
      ttl_sec: 300
    });
  });

  it("inject POSTs to /data", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true })
    }));
    const admin = new AdminClient({
      baseUrl: "http://admin.example",
      fetch: fetchMock as unknown as typeof fetch
    });
    await admin.inject("room-1", { payload: "hi", dest: "all" });
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "http://admin.example/v1/sessions/room-1/data"
    );
  });
});
