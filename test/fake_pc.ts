type DcInit = RTCDataChannelInit | undefined;

class FakeDataChannel {
  constructor(
    readonly label: string,
    readonly init?: DcInit
  ) {}
  readyState = "open";
  send(_data: string): void {}
  close(): void {}
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
  private channels: FakeDataChannel[] = [];
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
