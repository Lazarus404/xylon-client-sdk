/** Options for targeted JSON datachannel sends. */
export type SendJsonOptions = {
  /**
   * Participant id or id list. Written to envelope `"to"`.
   * Omit for Session default fanout. Do not pass role/group filters here;
   * resolve those via Control `POST .../dest/resolve` first.
   */
  dest?: string | string[];
};

type SendableChannel = {
  readyState: string;
  send: (data: string) => void;
};

/**
 * Builds a JSON string with optional `"to"` dest for media-path targeting.
 *
 * @throws if `payload` is not a plain object (or JSON object string).
 */
export function encodeTargetedJson(
  payload: Record<string, unknown> | string,
  opts: SendJsonOptions = {}
): string {
  let obj: Record<string, unknown>;
  if (typeof payload === "string") {
    const parsed = JSON.parse(payload) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("sendJson payload string must decode to a JSON object");
    }
    obj = { ...(parsed as Record<string, unknown>) };
  } else if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    obj = { ...payload };
  } else {
    throw new Error("sendJson payload must be a plain object");
  }

  if (opts.dest !== undefined) {
    if (typeof opts.dest === "string") {
      if (opts.dest === "") throw new Error("dest string must be non-empty");
      obj.to = opts.dest;
    } else if (Array.isArray(opts.dest)) {
      if (opts.dest.length === 0 || opts.dest.some((id) => typeof id !== "string" || id === "")) {
        throw new Error("dest list must be non-empty strings");
      }
      obj.to = [...opts.dest];
    } else {
      throw new Error("dest must be a string or string array");
    }
  }

  return JSON.stringify(obj);
}

/**
 * Sends a JSON object on an open datachannel, optionally setting `"to"`.
 */
export function sendJson(
  channel: SendableChannel,
  payload: Record<string, unknown> | string,
  opts: SendJsonOptions = {}
): void {
  if (channel.readyState !== "open") {
    throw new Error("datachannel not open");
  }
  channel.send(encodeTargetedJson(payload, opts));
}

/**
 * Resolves a Control dest filter to ids (or `"all"`), then sends with `"to"` when
 * the result is an id list. `"all"` omits `"to"` (Session default fanout).
 *
 * Never puts `{group: ...}` on the media envelope.
 */
export async function sendResolvedJson(
  channel: SendableChannel,
  payload: Record<string, unknown> | string,
  resolved: "all" | string[]
): Promise<void> {
  if (resolved === "all") {
    sendJson(channel, payload);
    return;
  }
  sendJson(channel, payload, { dest: resolved });
}
