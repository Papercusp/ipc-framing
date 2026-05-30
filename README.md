# @papercusp/ipc-framing

A length-prefixed binary frame codec for IPC / socket byte streams.

Wire format: `[4B big-endian length][1B type][payload]` (16 MiB cap). A
`FrameDecoder` state machine coalesces incoming chunks and emits complete
frames as they arrive.

```ts
import { encodeFrame, encodeJsonFrame, FrameType, FrameDecoder } from '@papercusp/ipc-framing';

const wire = encodeJsonFrame(FrameType.REQUEST, { id: 1, method: 'GET' });

const dec = new FrameDecoder();
dec.push(chunk);           // feed socket bytes
for (const frame of dec.drain()) { /* { type, payload } */ }
```

Also: `encodeEventBinPayload` / `decodeEventBinPayload` for the
self-describing `EVENT_BIN` layout (`[8B id][4B nameLen][name][binary]`).

**Pure**: only Node's `Buffer`; no other deps, no domain coupling. The full
wire spec lives in the operator's `endpoint-ipc/PROTOCOL.md`; the Rust client
in papercusp-desktop mirrors this byte-for-byte, so changes here are a
cross-language contract — keep them in lockstep.
