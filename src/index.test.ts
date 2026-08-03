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
 * The cross-language byte-for-byte pin.
 *
 * GOLDEN_REQUEST_FRAME is the shared fixture: the Rust mirror in
 * endpoint_ipc_framing.rs asserts the SAME bytes in its
 * `golden_request_frame_matches_ts` test. If you change either encoder, both
 * tests fail together — which is the point. Round-trip tests alone cannot catch
 * a mirrored-but-wrong layout, because each side would happily agree with itself.
 *
 * It pins REQUEST (0x01) because that is a frame the Rust client actually
 * sends. It used to pin DATA (0x07), which was removed with the frame
 * (WI-7545) — the pin was re-pointed rather than dropped, so deleting dead
 * protocol surface did not silently cost the live frames their coverage.
 */
const GOLDEN_REQUEST_FRAME = [
  0x00, 0x00, 0x00, 0x08, // length = 8
  0x01,                   // type = REQUEST
  0x7b, 0x22, 0x69, 0x64, 0x22, 0x3a, 0x31, 0x7d, // {"id":1}
];

describe('frame type tags', () => {
  it('matches the golden byte vector the Rust mirror also asserts', () => {
    const frame = encodeFrame(FrameType.REQUEST, Buffer.from('{"id":1}'));
    expect([...frame]).toEqual(GOLDEN_REQUEST_FRAME);
  });

  it('assigns every tag exactly once', () => {
    const tags = Object.values(FrameType);
    expect(new Set(tags).size).toBe(tags.length);
  });

  it('leaves 0x07 RESERVED — it was DATA, and reusing it would collide', () => {
    // DATA was removed (WI-7545). The byte must not come back as something
    // else: that would silently mean one thing to an old build and another to
    // a new one. Both sides pin this — see the Rust twin.
    expect(Object.values(FrameType)).not.toContain(0x07);
  });
});
