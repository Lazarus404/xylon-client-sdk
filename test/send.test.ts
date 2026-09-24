import { describe, expect, it } from "vitest";
import { encodeTargetedJson, sendJson } from "../src/send.js";

class FakeDc {
  readyState = "open";
  sent: string[] = [];
  send(data: string): void {
    this.sent.push(data);
  }
}

describe("encodeTargetedJson", () => {
  it("omits to when dest not set", () => {
    const s = encodeTargetedJson({ type: "chat", text: "hi" });
    expect(JSON.parse(s)).toEqual({ type: "chat", text: "hi" });
  });

  it("sets string and list dest", () => {
    expect(JSON.parse(encodeTargetedJson({ type: "chat", text: "x" }, { dest: "b" }))).toEqual({
      type: "chat",
      text: "x",
      to: "b"
    });
    expect(
      JSON.parse(encodeTargetedJson({ type: "chat", text: "x" }, { dest: ["b", "c"] }))
    ).toEqual({ type: "chat", text: "x", to: ["b", "c"] });
  });

  it("rejects empty dest", () => {
    expect(() => encodeTargetedJson({ type: "chat" }, { dest: "" })).toThrow(/non-empty/);
    expect(() => encodeTargetedJson({ type: "chat" }, { dest: [] })).toThrow(/non-empty/);
  });
});

describe("sendJson", () => {
  it("sends on open channel", () => {
    const dc = new FakeDc();
    sendJson(dc, { type: "chat", text: "hi" }, { dest: "b" });
    expect(dc.sent).toHaveLength(1);
    expect(JSON.parse(dc.sent[0]!)).toMatchObject({ to: "b", text: "hi" });
  });

  it("throws when channel closed", () => {
    const dc = new FakeDc();
    dc.readyState = "closed";
    expect(() => sendJson(dc, { type: "chat", text: "hi" })).toThrow(/not open/);
  });
});
