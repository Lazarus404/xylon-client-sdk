/** Standard datachannel labels for game / chat rooms. */
export const CHAT_LABEL = "chat";
export const RPC_LABEL = "rpc";
export const STATE_LABEL = "state";

/**
 * Recommended `RTCDataChannelInit` for the `state` label: unordered,
 * zero retransmits (lossy / latest-wins with client seq drop).
 */
export const STATE_CHANNEL_INIT: RTCDataChannelInit = {
  ordered: false,
  maxRetransmits: 0
};

/** Default connect labels for a three-channel game room. */
export const GAME_DATA_CHANNEL_LABELS: readonly string[] = [
  CHAT_LABEL,
  RPC_LABEL,
  STATE_LABEL
];

/** Default channel init for a known label (state is unreliable). */
export function defaultDataChannelInit(label: string): RTCDataChannelInit {
  if (label === STATE_LABEL) return { ...STATE_CHANNEL_INIT };
  return { ordered: true };
}
