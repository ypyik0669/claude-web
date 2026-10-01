// A Link carries channel frames (frames.ts) between the phone and the PC, whatever the transport: the direct
// WebRTC data channel or the slow relay over MQTT. Shared by the Node server and the phone shell.

export type LinkKind = 'p2p-v6' | 'p2p-v4' | 'relay';

export interface Link {
  kind: LinkKind;
  /**
   * Queues one whole frame; frames arrive whole, in order and once. The bytes are copied, so the caller may reuse
   * its buffer. Throws RangeError for a frame over 1 MiB (1 048 576 bytes; channel frames are at most 16 389).
   * Ignored after the link ended. Never calls onclose from inside itself: a link it ends (a queue past its bound)
   * reports that a microtask later.
   */
  send(frame: Uint8Array): void;
  /** Each frame from the other side; the array is the receiver's own (nothing else references it). */
  onframe: (f: Uint8Array) => void;
  /** The link ended for any reason but our own close(): the other side closed, went silent, or an error. Once. */
  onclose: (why: string) => void;
  /**
   * For good, and tells the other side. Frames still queued and frames the other side has not confirmed are
   * discarded, not delivered first. onclose is not called for it.
   */
  close(): void;
  /** Bytes handed to send() that the other side has not confirmed yet; callers pause while this is high. */
  buffered(): number;
}
