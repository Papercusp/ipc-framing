import { describe, expect, it } from 'vitest';
import {
  FrameType,
  FrameDecoder,
  FrameError,
  HEADER_BYTES,
  MAX_FRAME_BYTES,
  encodeFrame,
  encodeJsonFrame,
  encodeEventBinPayload,
  decodeEventBinPayload,
  encodeDataPayload,
  decodeDataPayload,
} from './index';

describe('encodeFrame', () => {
  it('writes [len BE u32][type u8][payload]', () => {
    const payload = Buffer.from('hello');
    const f = encodeFrame(FrameType.REQUEST, payload);
    expect(f.length).toBe(HEADER_BYTES + 5);
    expect(f.readUInt32BE(0)).toBe(5);
    expect(f.readUInt8(4)).toBe(FrameType.REQUEST);
    expect(f.subarray(5).toString()).toBe('hello');
  });

  it('rejects payloads over the 16 MiB cap', () => {
    const huge = Buffer.alloc(MAX_FRAME_BYTES + 1);
    expect(() => encodeFrame(FrameType.EVENT_BIN, huge)).toThrow(FrameError);
  });

  // S1: the cap is inclusive — a payload of EXACTLY MAX_FRAME_BYTES is accepted
  // (the guard is `> cap`, not `>= cap`). Only cap+1 (above) is rejected.
  it('accepts a payload of exactly MAX_FRAME_BYTES (inclusive cap)', () => {
    const atCap = Buffer.alloc(MAX_FRAME_BYTES);
    const f = encodeFrame(FrameType.EVENT_BIN, atCap);
    expect(f.length).toBe(HEADER_BYTES + MAX_FRAME_BYTES);
    expect(f.readUInt32BE(0)).toBe(MAX_FRAME_BYTES);
  });

  it('handles zero-length payloads', () => {
    const f = encodeFrame(FrameType.CANCEL, Buffer.alloc(0));
    expect(f.length).toBe(HEADER_BYTES);
    expect(f.readUInt32BE(0)).toBe(0);
  });
});

describe('encodeJsonFrame', () => {
  it('round-trips object payloads via JSON', () => {
    const f = encodeJsonFrame(FrameType.REQUEST, { id: 7, toolName: 'foo:bar' });
    const decoded = JSON.parse(f.subarray(HEADER_BYTES).toString('utf8'));
    expect(decoded).toEqual({ id: 7, toolName: 'foo:bar' });
  });
});

describe('encodeEventBinPayload / decodeEventBinPayload', () => {
  it('round-trips id + name + binary', () => {
    const binary = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0x42]);
    const payload = encodeEventBinPayload(123456789012345n, 'image_chunk', binary);
    const decoded = decodeEventBinPayload(payload);
    expect(decoded.id).toBe(123456789012345n);
    expect(decoded.name).toBe('image_chunk');
    expect(Array.from(decoded.binary)).toEqual(Array.from(binary));
  });

  it('rejects truncated payloads', () => {
    expect(() => decodeEventBinPayload(Buffer.from([1, 2, 3]))).toThrow(FrameError);
  });

  // S1: nameLen is a BYTE length, not a char count. A name with multibyte UTF-8
  // code points (accented + emoji) must round-trip exactly, and the encoded
  // nameLen field must equal the UTF-8 byte length (> the char count), proving the
  // length is bytes. Truncating at a char count would corrupt the binary split.
  it('nameLen is byte-length, not char-count (multibyte name round-trips)', () => {
    const name = 'café🎧'; // 5 code points; 'é'=2 bytes, '🎧'=4 bytes → 9 bytes
    const byteLen = Buffer.byteLength(name, 'utf8');
    expect(byteLen).toBe(9);
    expect(byteLen).toBeGreaterThan([...name].length); // bytes > chars
    const binary = new Uint8Array([0x01, 0x02, 0x03]);
    const payload = encodeEventBinPayload(7n, name, binary);
    // The on-wire nameLen field (bytes 8..12) must be the BYTE length.
    expect(payload.readUInt32BE(8)).toBe(byteLen);
    const decoded = decodeEventBinPayload(payload);
    expect(decoded.name).toBe(name);
    expect(Array.from(decoded.binary)).toEqual([0x01, 0x02, 0x03]);
  });

  it('rejects payload with nameLen exceeding remaining bytes', () => {
    // 8B id + 4B nameLen=999 + 4B "name" — too short
    const bad = Buffer.alloc(8 + 4 + 4);
    bad.writeBigUInt64BE(1n, 0);
    bad.writeUInt32BE(999, 8);
    expect(() => decodeEventBinPayload(bad)).toThrow(FrameError);
  });

  it('handles empty binary tail (header-only metadata)', () => {
    const payload = encodeEventBinPayload(1n, 'pulse', new Uint8Array(0));
    const decoded = decodeEventBinPayload(payload);
    expect(decoded.binary.length).toBe(0);
  });
});

describe('FrameDecoder', () => {
  it('decodes a single frame pushed in one chunk', () => {
    const dec = new FrameDecoder();
    dec.push(encodeFrame(FrameType.DONE, Buffer.from('{"id":1}')));
    const out = dec.drain();
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe(FrameType.DONE);
    expect(out[0].payload.toString()).toBe('{"id":1}');
  });

  it('decodes multiple frames pushed in one chunk', () => {
    const dec = new FrameDecoder();
    const f1 = encodeJsonFrame(FrameType.EVENT_JSON, { id: 1, name: 'a', data: 1 });
    const f2 = encodeJsonFrame(FrameType.EVENT_JSON, { id: 1, name: 'b', data: 2 });
    const f3 = encodeJsonFrame(FrameType.DONE, { id: 1, result: {} });
    dec.push(Buffer.concat([f1, f2, f3]));
    const out = dec.drain();
    expect(out).toHaveLength(3);
    expect(out.map((f) => f.type)).toEqual([
      FrameType.EVENT_JSON,
      FrameType.EVENT_JSON,
      FrameType.DONE,
    ]);
  });

  it('handles a frame split across many tiny chunks', () => {
    const dec = new FrameDecoder();
    const payload = Buffer.from(JSON.stringify({ id: 42, name: 'big', data: 'x'.repeat(500) }));
    const frame = encodeFrame(FrameType.EVENT_JSON, payload);
    for (const byte of frame) {
      dec.push(Buffer.from([byte]));
    }
    const out = dec.drain();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].payload.toString())).toEqual({
      id: 42,
      name: 'big',
      data: 'x'.repeat(500),
    });
  });

  it('drain() returns only newly-ready frames; subsequent calls return []', () => {
    const dec = new FrameDecoder();
    dec.push(encodeJsonFrame(FrameType.CANCEL, { id: 1 }));
    expect(dec.drain()).toHaveLength(1);
    expect(dec.drain()).toHaveLength(0);
  });

  it('buffers a partial frame between push() calls', () => {
    const dec = new FrameDecoder();
    const frame = encodeJsonFrame(FrameType.EVENT_JSON, { id: 1, name: 'x', data: 'y' });
    dec.push(frame.subarray(0, 3));
    expect(dec.drain()).toHaveLength(0);
    expect(dec.bufferedBytes).toBe(3);
    dec.push(frame.subarray(3));
    const out = dec.drain();
    expect(out).toHaveLength(1);
    expect(dec.bufferedBytes).toBe(0);
  });

  it('throws on unknown frame type', () => {
    const dec = new FrameDecoder();
    const bad = Buffer.from([0, 0, 0, 0, 0x99]); // length=0, type=0x99
    expect(() => dec.push(bad)).toThrow(/unknown frame type/);
  });

  it('throws on oversized frame length', () => {
    const dec = new FrameDecoder();
    const bad = Buffer.alloc(HEADER_BYTES);
    bad.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
    bad.writeUInt8(FrameType.REQUEST, 4);
    expect(() => dec.push(bad)).toThrow(/incoming frame too large/);
  });

  it('payload buffers are independent of the input chunk (no aliasing)', () => {
    const dec = new FrameDecoder();
    const payload = Buffer.from('{"id":1}');
    const frame = encodeFrame(FrameType.DONE, payload);
    const chunk = Buffer.from(frame);
    dec.push(chunk);
    const out = dec.drain();
    // Mutate the input chunk after decode; output must be unaffected.
    chunk.fill(0);
    expect(out[0].payload.toString()).toBe('{"id":1}');
  });
});

/**
 * DATA (0x07) — no-http-anywhere-2026-07-28 P-012.
 *
 * The plan's binding requirement is that this frame is "mirrored byte-for-byte"
 * in endpoint_ipc_framing.rs. GOLDEN_DATA_FRAME below is the shared fixture:
 * the Rust suite asserts the SAME bytes in its `golden_data_frame_matches_ts`
 * test. If you change either encoder, both tests fail together — which is the
 * point. A round-trip test alone cannot catch a mirrored-but-wrong layout,
 * because each side would happily agree with itself.
 */
const GOLDEN_DATA_FRAME = [
  0x00, 0x00, 0x00, 0x0a, // length = 10 (8B id + 2B payload)
  0x07,                   // type = DATA
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, // id = 1 (u64 BE)
  0xaa, 0xbb,             // payload
];

describe('DATA frame (0x07)', () => {
  it('matches the golden byte vector the Rust mirror also asserts', () => {
    const frame = encodeFrame(FrameType.DATA, encodeDataPayload(1n, Uint8Array.from([0xaa, 0xbb])));
    expect([...frame]).toEqual(GOLDEN_DATA_FRAME);
  });

  it('round-trips id + payload', () => {
    const p = encodeDataPayload(0xdeadbeefn, Uint8Array.from([1, 2, 3]));
    const d = decodeDataPayload(p);
    expect(d.id).toBe(0xdeadbeefn);
    expect([...d.payload]).toEqual([1, 2, 3]);
  });

  it('preserves a full u64 id without precision loss', () => {
    // Past Number.MAX_SAFE_INTEGER — the reason the codec uses bigint.
    const big = 0xfffffffffffffffen;
    expect(decodeDataPayload(encodeDataPayload(big, new Uint8Array())).id).toBe(big);
  });

  it('accepts a ZERO-byte tail (end-of-stream without tearing the call down)', () => {
    const p = encodeDataPayload(7n, new Uint8Array());
    expect(p.length).toBe(8);
    const d = decodeDataPayload(p);
    expect(d.id).toBe(7n);
    expect(d.payload.length).toBe(0);
  });

  it('rejects a payload too short to carry an id', () => {
    expect(() => decodeDataPayload(Buffer.alloc(7))).toThrow(FrameError);
  });

  it('decodes through the streaming decoder like any other frame', () => {
    const dec = new FrameDecoder();
    dec.push(encodeFrame(FrameType.DATA, encodeDataPayload(9n, Uint8Array.from([0xff]))));
    const out = dec.drain();
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe(FrameType.DATA);
    expect(decodeDataPayload(out[0]!.payload).id).toBe(9n);
  });

  it('is a distinct tag that does not collide with an existing frame type', () => {
    const tags = Object.values(FrameType);
    expect(new Set(tags).size).toBe(tags.length);
    expect(FrameType.DATA).toBe(0x07);
  });
});
