type DcInit = RTCDataChannelInit | undefined;

class FakeDataChannel {
  constructor(
    readonly label: string,
    readonly init?: DcInit
  ) {}
  readyState = "open";
  sent: string[] = [];
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {}
}

/** Fake RTCRtpSender for Dynacast / encoding tests. */
export class FakeRtpSender {
  track: { kind: string } | null;
  encodings: Array<{ rid?: string; active?: boolean }>;
  setParametersCalls = 0;

  constructor(
    track: { kind: string } | null,
    encodings: Array<{ rid?: string; active?: boolean }>
  ) {
    this.track = track;
    this.encodings = encodings.map((e) => ({ ...e }));
  }

  getParameters(): { encodings: Array<{ rid?: string; active?: boolean }> } {
    return { encodings: this.encodings.map((e) => ({ ...e })) };
  }

  async setParameters(params: {
    encodings?: Array<{ rid?: string; active?: boolean }>;
  }): Promise<void> {
    this.setParametersCalls += 1;
    this.encodings = (params.encodings ?? []).map((e) => ({ ...e }));
  }
}

/** Fake RTCRtpTransceiver with mid + sender. */
export class FakeRtpTransceiver {
  mid: string | null;
  sender: FakeRtpSender;

  constructor(mid: string | null, sender: FakeRtpSender) {
    this.mid = mid;
    this.sender = sender;
  }
}

/** Minimal RTCPeerConnection for room unit tests. */
export class FakeRTCPeerConnection {
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  connectionState = "new";
  iceGatheringState = "new";
  createdLabels: string[] = [];
  createdInits: Array<{ label: string; init: DcInit }> = [];
  addedTracks: Array<{ track: { kind: string }; stream?: MediaStream }> = [];
  onicecandidate: ((ev: { candidate: FakeIceCandidate | null }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((ev: { channel: FakeDataChannel }) => void) | null = null;
  onicegatheringstatechange: (() => void) | null = null;
  private channels: FakeDataChannel[] = [];
  /** Test-installed or addTransceiver-created rows. */
  transceivers: FakeRtpTransceiver[] = [];
  addedRemoteCandidates: Array<{
    candidate: string | null;
    sdpMid: string | null;
    sdpMLineIndex: number | null;
  }> = [];

  constructor(_config?: RTCConfiguration) {}

  createDataChannel(label: string, init?: DcInit): FakeDataChannel {
    this.createdLabels.push(label);
    this.createdInits.push({ label, init });
    const dc = new FakeDataChannel(label, init);
    this.channels.push(dc);
    return dc;
  }

  addTrack(track: { kind: string }, stream?: MediaStream): void {
    this.addedTracks.push({ track, stream });
    const sender = new FakeRtpSender(track, []);
    this.transceivers.push(new FakeRtpTransceiver(null, sender));
  }

  addTransceiver(
    trackOrKind: { kind: string } | string,
    init?: RTCRtpTransceiverInit
  ): FakeRtpTransceiver {
    const track =
      typeof trackOrKind === "string" ? { kind: trackOrKind } : trackOrKind;
    if (typeof trackOrKind !== "string") {
      this.addedTracks.push({ track, stream: init?.streams?.[0] });
    }
    const encodings = (init?.sendEncodings ?? []).map((e) => ({
      rid: e.rid,
      active: e.active !== false
    }));
    const sender = new FakeRtpSender(track, encodings);
    const tr = new FakeRtpTransceiver(null, sender);
    this.transceivers.push(tr);
    return tr;
  }

  getTransceivers(): FakeRtpTransceiver[] {
    return this.transceivers;
  }

  getSenders(): FakeRtpSender[] {
    return this.transceivers.map((t) => t.sender);
  }

  /** Assign mids after offer (tests / setLocalDescription). */
  assignMids(mids: Array<string | null>): void {
    this.transceivers.forEach((tr, i) => {
      tr.mid = mids[i] ?? tr.mid;
    });
  }

  async createOffer(): Promise<{ type: "offer"; sdp: string }> {
    const labels = this.createdLabels.join(",");
    const kinds = this.addedTracks.map((t) => t.track.kind).join(",");
    return {
      type: "offer",
      sdp: `v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=label:${labels}\r\na=tracks:${kinds}`
    };
  }

  async setLocalDescription(desc: { type: string; sdp: string }): Promise<void> {
    this.localDescription = desc;
    // Assign sequential mids for media transceivers still unbound.
    let next = 0;
    for (const tr of this.transceivers) {
      if (tr.mid == null) {
        tr.mid = String(next);
        next += 1;
      }
    }
    this.iceGatheringState = "gathering";
    queueMicrotask(() => {
      if (this.onicecandidate) {
        this.onicecandidate({
          candidate: {
            candidate: "candidate:1 1 UDP 2130706431 127.0.0.1 9 typ host",
            sdpMid: "0",
            sdpMLineIndex: 0
          }
        });
        this.onicecandidate({ candidate: null });
      }
      this.iceGatheringState = "complete";
      this.onicegatheringstatechange?.();
    });
  }

  async setRemoteDescription(desc: { type: string; sdp: string }): Promise<void> {
    this.remoteDescription = desc;
    this.connectionState = "connected";
    this.onconnectionstatechange?.();
  }

  async addIceCandidate(init: {
    candidate?: string | null;
    sdpMid?: string | null;
    sdpMLineIndex?: number | null;
  }): Promise<void> {
    this.addedRemoteCandidates.push({
      candidate: init.candidate ?? null,
      sdpMid: init.sdpMid ?? null,
      sdpMLineIndex: init.sdpMLineIndex ?? null
    });
  }

  close(): void {
    this.connectionState = "closed";
    this.onconnectionstatechange?.();
  }
}

type FakeIceCandidate = {
  candidate: string;
  sdpMid: string;
  sdpMLineIndex: number;
};
