/**
 * Endpoint IPC frame codec. See PROTOCOL.md in this directory for the
 * complete wire spec. The Rust client in papercusp-desktop has a
 * byte-for-byte mirror of this file.
 *
 * Frame: [4B BE length][1B type][payload].
 *
 * Stateless, allocation-light: the encoder writes into a pre-sized
 * Buffer, the decoder runs a small state machine that emits frames as
 * they complete and parks otherwise.
 */

export const FrameType = {
  REQUEST:    0x01,
  EVENT_JSON: 0x02,
  DONE:       0x03,
  ERROR:      0x04,
  EVENT_BIN:  0x05,
  CANCEL:     0x06,
  /**
   * Client → Server payload for an in-flight call (no-http-anywhere-2026-07-28
   * P-012). REQUEST + CANCEL alone make the channel server-STREAMING: once a
   * call is open the client can only abandon it, never feed it. DATA is what
   * makes it full duplex, so a long-lived stream (the P-013 WebSocket shim, and
   * the PTY/voice connections behind P-014) can ride this channel instead of
   * holding a real socket.
   */
  DATA:       0x07,
} as const;

export type FrameTypeValue = (typeof FrameType)[keyof typeof FrameType];

/** Hard cap per PROTOCOL.md — 16 MiB. Senders refuse, receivers close. */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export const HEADER_BYTES = 5;

export interface Frame {
  type: FrameTypeValue;
  payload: Buffer;
}

/** Encode one frame. Returns a new Buffer including the 5-byte header. */
export function encodeFrame(type: FrameTypeValue, payload: Buffer): Buffer {
  if (payload.length > MAX_FRAME_BYTES) {
    throw new FrameError(
      `frame payload too large: ${payload.length} bytes (cap ${MAX_FRAME_BYTES})`,
    );
  }
  const out = Buffer.allocUnsafe(HEADER_BYTES + payload.length);
  out.writeUInt32BE(payload.length, 0);
  out.writeUInt8(type, 4);
  payload.copy(out, HEADER_BYTES);
  return out;
}

/** Convenience: encode a JSON-bodied frame. */
export function encodeJsonFrame(type: FrameTypeValue, value: unknown): Buffer {
  return encodeFrame(type, Buffer.from(JSON.stringify(value), 'utf8'));
}

/**
 * EVENT_BIN payload layout — `[8B id BE][4B nameLen BE][name UTF-8][binary]`.
 * Self-describing so no header/payload pairing state is required.
 */
export function encodeEventBinPayload(
  id: bigint,
  name: string,
  binary: Uint8Array,
): Buffer {
  const nameBuf = Buffer.from(name, 'utf8');
  const out = Buffer.allocUnsafe(8 + 4 + nameBuf.length + binary.byteLength);
  out.writeBigUInt64BE(id, 0);
  out.writeUInt32BE(nameBuf.length, 8);
  nameBuf.copy(out, 12);
  Buffer.from(
    binary.buffer,
    binary.byteOffset,
    binary.byteLength,
  ).copy(out, 12 + nameBuf.length);
  return out;
}

export interface DecodedEventBin {
  id: bigint;
  name: string;
  binary: Buffer;
}

/** Parse an EVENT_BIN frame's payload back into id/name/binary. */
export function decodeEventBinPayload(payload: Buffer): DecodedEventBin {
  if (payload.length < 12) {
    throw new FrameError(`EVENT_BIN payload too short: ${payload.length} bytes`);
  }
  const id = payload.readBigUInt64BE(0);
  const nameLen = payload.readUInt32BE(8);
  if (12 + nameLen > payload.length) {
    throw new FrameError(
      `EVENT_BIN nameLen=${nameLen} exceeds payload (${payload.length} bytes)`,
    );
  }
  const name = payload.subarray(12, 12 + nameLen).toString('utf8');
  const binary = payload.subarray(12 + nameLen);
  return { id, name, binary };
}

/**
 * DATA payload layout — `[8B id BE][payload]`.
 *
 * Deliberately thinner than EVENT_BIN: that frame is self-describing because
 * the server multiplexes *named* events onto one call, whereas DATA is an
 * opaque byte run for an ALREADY-open call, so `id` is the only routing key
 * needed. No length prefix on the tail either — the frame header's own length
 * already bounds it, and duplicating that would create two sources of truth
 * that can disagree.
 */
export function encodeDataPayload(id: bigint, payload: Uint8Array): Buffer {
  const out = Buffer.allocUnsafe(8 + payload.byteLength);
  out.writeBigUInt64BE(id, 0);
  Buffer.from(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength,
  ).copy(out, 8);
  return out;
}

export interface DecodedData {
  id: bigint;
  payload: Buffer;
}

/** Parse a DATA frame's payload back into id/payload. */
export function decodeDataPayload(payload: Buffer): DecodedData {
  if (payload.length < 8) {
    throw new FrameError(`DATA payload too short: ${payload.length} bytes`);
  }
  return {
    id: payload.readBigUInt64BE(0),
    // A zero-byte tail is legal and meaningful — it is how a sender signals
    // "end of stream, no bytes" without tearing the call down.
    payload: payload.subarray(8),
  };
}

export class FrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrameError';
  }
}

/**
 * Streaming decoder. Push bytes via `push()`; ready frames come out of
 * `drain()`. Caller is responsible for closing the underlying socket
 * on FrameError.
 */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);
  private ready: Frame[] = [];

  push(chunk: Buffer): void {
    // Coalesce. Average chunk size is small so allocation cost is low.
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= HEADER_BYTES) {
      const len = this.buf.readUInt32BE(0);
      if (len > MAX_FRAME_BYTES) {
        throw new FrameError(`incoming frame too large: ${len} bytes`);
      }
      const total = HEADER_BYTES + len;
      if (this.buf.length < total) break;
      const type = this.buf.readUInt8(4) as FrameTypeValue;
      if (!Object.values(FrameType).includes(type)) {
        throw new FrameError(`unknown frame type: 0x${type.toString(16)}`);
      }
      const payload = this.buf.subarray(HEADER_BYTES, total);
      // Copy out so subsequent buf trim doesn't shift payload bytes.
      this.ready.push({ type, payload: Buffer.from(payload) });
      this.buf = this.buf.subarray(total);
    }
  }

  drain(): Frame[] {
    const out = this.ready;
    this.ready = [];
    return out;
  }

  /** Bytes buffered but not yet a complete frame. For diagnostics only. */
  get bufferedBytes(): number {
    return this.buf.length;
  }
}
