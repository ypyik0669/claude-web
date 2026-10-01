// A Link carries channel frames (frames.ts) between the phone and the PC, whatever the transport: the direct
// WebRTC data channel or the slow relay over MQTT. Shared by the Node server and the phone shell.

export type LinkKind = 'p2p-v6' | 'p2p-v4' | 'relay';

export interface Link {
  kind: LinkKind;
  /**
   * Queues one whole frame; frames arrive whole, in order and once. The bytes are copied, so the caller may reuse
   * its buffer. Ignored after the link ended.
   */
  send(frame: Uint8Array): void;
  /** Each frame from the other side; the array is the receiver's own (nothing else references it). */
  onframe: (f: Uint8Array) => void;
  /** The link ended for any reason but our own close(): the other side closed, went silent, or an error. Once. */
  onclose: (why: string) => void;
  /** For good, and tells the other side. onclose is not called for it. */
  close(): void;
  /** Bytes handed to send() that the other side has not confirmed yet; callers pause while this is high. */
  buffered(): number;
}
