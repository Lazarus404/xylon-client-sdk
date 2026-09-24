import type { RestAuth } from "./types.js";

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

async function getJson(
  url: string,
  token: string
): Promise<unknown> {
  const res = await fetch(url, {
    method: "GET",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json"
    }
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body}`);
  }
  return res.json();
}

async function postJson(
  url: string,
  token: string,
  body: Record<string, unknown>
): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

/** `GET /v1/tenants/:tid/sessions/:sid/presence` with host-minted Bearer. */
export async function fetchPresence(
  baseUrl: string,
  auth: RestAuth
): Promise<unknown> {
  const url =
    `${trimSlash(baseUrl)}/v1/tenants/${encodeURIComponent(auth.tenantId)}` +
    `/sessions/${encodeURIComponent(auth.sessionId)}/presence`;
  return getJson(url, auth.token);
}

/** `GET /v1/tenants/:tid/sessions/:sid/history?label=` with host-minted Bearer. */
export async function fetchHistory(
  baseUrl: string,
  auth: RestAuth & { label?: string }
): Promise<unknown> {
  const label = auth.label ?? "chat";
  const url =
    `${trimSlash(baseUrl)}/v1/tenants/${encodeURIComponent(auth.tenantId)}` +
    `/sessions/${encodeURIComponent(auth.sessionId)}/history` +
    `?label=${encodeURIComponent(label)}`;
  return getJson(url, auth.token);
}

/** Dest filter accepted by Control `POST .../dest/resolve`. */
export type ResolveDestFilter =
  | "all"
  | "except"
  | string[]
  | { group: string }
  | { groups: string[] }
  | { role: string }
  | { attr: Record<string, unknown> }
  | Record<string, unknown>;

export type ResolveDestResult = {
  ok: true;
  dest: "all" | string[];
};

/**
 * `POST /v1/tenants/:tid/sessions/:sid/dest/resolve`.
 *
 * Resolves role/group filters to `"all"` or a participant id list. Never put
 * group names on the datachannel envelope -- pass the returned ids to `sendJson`.
 */
export async function resolveDest(
  baseUrl: string,
  auth: RestAuth & { participantId?: string },
  dest: ResolveDestFilter
): Promise<ResolveDestResult> {
  const url =
    `${trimSlash(baseUrl)}/v1/tenants/${encodeURIComponent(auth.tenantId)}` +
    `/sessions/${encodeURIComponent(auth.sessionId)}/dest/resolve`;
  const body: Record<string, unknown> = { dest };
  if (auth.participantId) body.participant_id = auth.participantId;
  const data = (await postJson(url, auth.token, body)) as {
    ok?: boolean;
    dest?: "all" | string[];
  };
  if (!data || data.ok !== true || data.dest === undefined) {
    throw new Error("dest/resolve: unexpected response");
  }
  return { ok: true, dest: data.dest };
}
