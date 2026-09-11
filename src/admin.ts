/** Options / errors for customer-admin HTTP (never Xylon Control edge). */

export type AdminPrepareRequest = (req: {
  method: string;
  url: string;
  headers: Headers;
  body?: BodyInit | null;
}) => void | Promise<void>;

export type AdminClientOptions = {
  /** Customer admin base URL, e.g. `http://127.0.0.1:8092`. */
  baseUrl: string;
  /** Merged into every request before `prepareRequest`. */
  defaultHeaders?: HeadersInit;
  /** Fetch credentials mode (default `same-origin`). Use `include` for cookies. */
  credentials?: RequestCredentials;
  /**
   * Host auth hook: mutate headers (or inspect body) before fetch.
   * Lab demos may omit this; real apps attach Bearer / CSRF / etc.
   */
  prepareRequest?: AdminPrepareRequest;
  /** Injected fetch (tests / custom transport). Defaults to global `fetch`. */
  fetch?: typeof fetch;
};

export type MintTokenBody = {
  session_id: string;
  participant_id: string;
  capabilities?: unknown;
  ttl_sec?: number;
};

/** Thrown when the customer admin HTTP response is not OK. */
export class AdminError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`Admin HTTP ${status}: ${body}`);
    this.name = "AdminError";
    this.status = status;
    this.body = body;
  }
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Thin HTTP client for a customer admin backend (e.g. demo-admin).
 * Calls `/v1/token` and `/v1/sessions/:sid/...` only -- never Xylon.
 */
export class AdminClient {
  readonly baseUrl: string;
  private readonly defaultHeaders: HeadersInit | undefined;
  private readonly credentials: RequestCredentials;
  private readonly prepareRequest: AdminPrepareRequest | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: AdminClientOptions) {
    if (!opts.baseUrl || typeof opts.baseUrl !== "string") {
      throw new Error("AdminClient: baseUrl required");
    }
    this.baseUrl = trimSlash(opts.baseUrl);
    this.defaultHeaders = opts.defaultHeaders;
    this.credentials = opts.credentials ?? "same-origin";
    this.prepareRequest = opts.prepareRequest;
    this.fetchImpl = opts.fetch ?? fetch.bind(globalThis);
  }

  /** `POST /v1/token` -- host mint for Control WS join. */
  async mintToken(body: MintTokenBody): Promise<{ token: string }> {
    const data = await this.requestJson("POST", "/v1/token", body);
    if (
      typeof data !== "object" ||
      data === null ||
      typeof (data as { token?: unknown }).token !== "string" ||
      (data as { token: string }).token === ""
    ) {
      throw new AdminError(200, "mint response missing token");
    }
    return { token: (data as { token: string }).token };
  }

  /** `GET /v1/sessions/:sid/presence` */
  presence(sessionId: string): Promise<unknown> {
    return this.requestJson(
      "GET",
      `/v1/sessions/${encodeURIComponent(sessionId)}/presence`
    );
  }

  /** `GET /v1/sessions/:sid/history?label=` */
  history(sessionId: string, label = "chat"): Promise<unknown> {
    const q = `?label=${encodeURIComponent(label)}`;
    return this.requestJson(
      "GET",
      `/v1/sessions/${encodeURIComponent(sessionId)}/history${q}`
    );
  }

  /** `POST /v1/sessions/:sid/data` (inject) */
  inject(sessionId: string, body: unknown): Promise<unknown> {
    return this.requestJson(
      "POST",
      `/v1/sessions/${encodeURIComponent(sessionId)}/data`,
      body
    );
  }

  /** `POST /v1/sessions/:sid/moderate` */
  moderate(sessionId: string, body: unknown): Promise<unknown> {
    return this.requestJson(
      "POST",
      `/v1/sessions/${encodeURIComponent(sessionId)}/moderate`,
      body
    );
  }

  private async requestJson(
    method: string,
    path: string,
    jsonBody?: unknown
  ): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const headers = new Headers(this.defaultHeaders);
    if (!headers.has("accept")) {
      headers.set("accept", "application/json");
    }

    const hasBody = jsonBody !== undefined;
    const body: BodyInit | null = hasBody ? JSON.stringify(jsonBody) : null;
    if (hasBody && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }

    if (this.prepareRequest) {
      await this.prepareRequest({ method, url, headers, body });
    }

    const init: RequestInit = {
      method,
      headers,
      credentials: this.credentials
    };
    if (hasBody) {
      init.body = body;
    }

    const res = await this.fetchImpl(url, init);

    if (!res.ok) {
      const text = await res.text();
      throw new AdminError(res.status, text);
    }

    if (res.status === 204) {
      return null;
    }
    const text = await res.text();
    if (!text) {
      return null;
    }
    return JSON.parse(text) as unknown;
  }
}
