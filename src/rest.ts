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
