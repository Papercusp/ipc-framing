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
