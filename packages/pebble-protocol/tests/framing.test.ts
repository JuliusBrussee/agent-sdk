import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_MAX_FRAME_BYTES,
  decodeFrames,
  encodeFrame,
  encodeFrameText,
  JsonlDecoder,
  ProtocolError,
} from "../src/framing.ts";
import { eventNotification, unwrapEvent } from "../src/framing.ts";
import { isTurnEvent } from "../src/events.ts";

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });

function bytes(s: string): Uint8Array {
  return enc.encode(s);
}

test("decodes a single frame from one push", () => {
  const d = new JsonlDecoder();
  const out = d.push(bytes('{"a":1}\n'));
  assert.deepEqual(out, [{ a: 1 }]);
  assert.equal(d.buffered, 0);
  d.end(); // must not throw
});

test("decodes multiple frames from one push, in order", () => {
  const frames = decodeFrames(bytes('{"n":1}\n{"n":2}\n\n{"n":3}\n'));
  assert.deepEqual(frames, [{ n: 1 }, { n: 2 }, { n: 3 }]);
});

test("blank lines are skipped silently", () => {
  const frames = decodeFrames(bytes('\n \n\t\n{"x":true}\n   \n'));
  assert.deepEqual(frames, [{ x: true }]);
});

test("frames split across arbitrary chunk boundaries reassemble", () => {
  const wire = bytes(
    '{"kind":"turn.start","seq":1}\n' +
      '{"kind":"delta.text","text":"hi"}\n' +
      '{"kind":"turn.end"}\n',
  );
  for (let splitAt = 1; splitAt < wire.length; splitAt++) {
    const d = new JsonlDecoder();
    const a = d.push(wire.subarray(0, splitAt));
    const b = d.push(wire.subarray(splitAt));
    const all = [...a, ...b];
    assert.equal(all.length, 3, `split at ${splitAt}`);
    d.end();
  }
});

test("byte-at-a-time streaming decodes exactly once per frame", () => {
  const wire = bytes('{"v":1}\n{"v":2}\n');
  const d = new JsonlDecoder();
  const seen: unknown[] = [];
  for (const b of wire) seen.push(...d.push(Uint8Array.of(b)));
  assert.deepEqual(seen, [{ v: 1 }, { v: 2 }]);
});

test("multi-byte UTF-8 split across chunk boundaries survives", () => {
  // 🦴 is F0 9F A6 B4 — every internal byte is a continuation byte; splitting
  // mid-codepoint must not corrupt the decoded frame.
  const frame = JSON.stringify({ text: "🦴💀" }) + "\n";
  const wire = bytes(frame);
  for (let splitAt = 1; splitAt < wire.length; splitAt++) {
    const d = new JsonlDecoder();
    const out = [
      ...d.push(wire.subarray(0, splitAt)),
      ...d.push(wire.subarray(splitAt)),
    ];
    assert.deepEqual(out, [{ text: "🦴💀" }], `split at ${splitAt}`);
  }
});

test("THE READLINE TRAP: raw U+2028/U+2029 inside a body survive intact", () => {
  // JSON.stringify does NOT escape U+2028/U+2029; Node readline would split
  // on them. Our decoder splits ONLY on 0x0A, so the frame must round-trip.
  const value = { text: "line one \u2028 still same line \u2029 para" };
  const wire = encodeFrame(value);
  // Prove the separators are physically present as RAW bytes (why the trap exists):
  assert.ok(wire.includes(0xe2), "U+2028 prefix byte present");
  const frames = decodeFrames(wire);
  assert.deepEqual(frames, [value]);
  assert.equal((frames[0] as { text: string }).text.includes("\u2028"), true);
  assert.equal((frames[0] as { text: string }).text.includes("\u2029"), true);
});

test("golden delta.text fixture (raw U+2028/U+2029) round-trips byte-stably", async () => {
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const path = new URL("../fixtures/delta.text.json", import.meta.url);
  const fileBytes = await readFile(fileURLToPath(path));
  const frames = decodeFrames(fileBytes);
  assert.equal(frames.length, 1);
  assert.ok(isTurnEvent(frames[0]));
  const reencoded = encodeFrameText(frames[0]);
  assert.ok(Buffer.from(reencoded).equals(fileBytes), "byte-stable re-encode");
});

test("\\r is NOT a terminator: CRLF peers interop, raw CR mid-body fails loudly", () => {
  // Trailing \r before \n is legal JSON whitespace, so CRLF-terminated frames
  // parse (interop); but re-encoding drops it — byte-stable hops need bare LF.
  const frames = decodeFrames(bytes('{"a":1}\r\n'));
  assert.deepEqual(frames, [{ a: 1 }]);

  // A RAW CR control byte inside a string value is illegal JSON → loud.
  // (Producers never hit this: JSON.stringify escapes \r inside strings.)
  const rawCrInString = Buffer.concat([
    Buffer.from('{"a":"'),
    Buffer.from([0x0d]),
    Buffer.from('b"}\n'),
  ]);
  assert.throws(
    () => decodeFrames(rawCrInString),
    (err: unknown) =>
      err instanceof ProtocolError && err.code === "bad-json",
  );
});

test("escaped \\r inside string values round-trips fine", () => {
  const frames = decodeFrames(bytes(JSON.stringify({ t: "a\rb" }) + "\n"));
  assert.deepEqual(frames, [{ t: "a\rb" }]);
});

test("incomplete trailing frame is held until its newline arrives", () => {
  const d = new JsonlDecoder();
  assert.deepEqual(d.push(bytes('{"par')), []);
  assert.ok(d.buffered > 0);
  assert.deepEqual(d.push(bytes('tial":7}\n')), [{ partial: 7 }]);
  assert.equal(d.buffered, 0);
});

test("end() throws on unparsed trailing bytes", () => {
  const d = new JsonlDecoder();
  d.push(bytes('{"ok":true}\n'));
  d.end(); // clean
  const d2 = new JsonlDecoder();
  d2.push(bytes('{"ok":true}\n{"cut'));
  assert.throws(
    () => d2.end(),
    (err: unknown) =>
      err instanceof ProtocolError && err.code === "trailing-bytes",
  );
});

test("frame exceeding maxFrameBytes fails closed without buffering forever", () => {
  const d = new JsonlDecoder({ maxFrameBytes: 64 });
  assert.throws(
    () => d.push(bytes("x".repeat(65))),
    (err: unknown) =>
      err instanceof ProtocolError && err.code === "frame-too-large",
  );
});

test("oversized push containing newlines still splits fine", () => {
  const big =
    JSON.stringify({ blob: "y".repeat(200) }) + "\n" +
    JSON.stringify({ blob: "z".repeat(200) }) + "\n";
  const frames = decodeFrames(bytes(big), { maxFrameBytes: 1024 });
  assert.equal(frames.length, 2);
});

test("invalid UTF-8 fails closed with bad-utf8", () => {
  const bad = Buffer.concat([Buffer.from([0xff, 0xfe]), bytes("\n")]);
  assert.throws(
    () => decodeFrames(bad),
    (err: unknown) =>
      err instanceof ProtocolError && err.code === "bad-utf8",
  );
});

test("invalid JSON fails loudly with frame position context", () => {
  assert.throws(
    () => decodeFrames(bytes("{not json}\n")),
    (err: unknown) =>
      err instanceof ProtocolError &&
      err.code === "bad-json" &&
      /frame 1/.test(err.message),
  );
});

test("encode → decode → re-encode is byte-stable across gnarly values", () => {
  const values = [
    { s: 'quotes " backslash \\ tab \t unicode é🦴 newline \n cr \r' },
    { nested: { deep: [{ list: [1, 2, 3] }], nul: null, bool: false } },
    { empty: "", zero: 0, big: 9007199254740991 },
    {},
    [],
    "top-level-string",
    42,
    null,
  ];
  for (const v of values) {
    const first = encodeFrame(v);
    const parsed = decodeFrames(first)[0];
    const second = encodeFrame(parsed);
    assert.ok(Buffer.from(second).equals(Buffer.from(first)), "stable bytes");
    assert.deepEqual(JSON.parse(dec.decode(second)), v);
  }
});

test("decoder tracks stream offset across compaction", () => {
  const d = new JsonlDecoder();
  d.push(bytes('{"one":1}\n{"two'));
  const afterFirstFrame = '{"one":1}\n'.length;
  assert.equal(d.streamOffset, afterFirstFrame);
  assert.deepEqual(d.push(bytes('":2}\n{"three":3}\n')), [{ two: 2 }, { three: 3 }]);
  assert.equal(d.streamOffset, afterFirstFrame + '{"two":2}\n{"three":3}\n'.length);
});

test("default max frame size is 16 MiB", () => {
  assert.equal(DEFAULT_MAX_FRAME_BYTES, 16 * 1024 * 1024);
});

// --- RPC envelopes ---------------------------------------------------------

import {
  EVENT_NOTIFICATION_METHOD,
  RPC_ERROR_CODES,
  rpcErrorResponse,
  rpcNotification,
  rpcRequest,
  rpcResponse,
} from "../src/framing.ts";
import {
  isRpcMessage,
  isRpcNotification,
  isRpcRequest,
  isRpcResponse,
} from "../src/framing.ts";

test("rpc constructors produce spec-shaped envelopes", () => {
  assert.deepEqual(rpcRequest(7, "ping"), {
    jsonrpc: "2.0",
    id: 7,
    method: "ping",
  });
  assert.deepEqual(rpcRequest("abc", "session/prompt", { x: 1 }), {
    jsonrpc: "2.0",
    id: "abc",
    method: "session/prompt",
    params: { x: 1 },
  });
  assert.deepEqual(rpcNotification("pebble/event", { k: 1 }), {
    jsonrpc: "2.0",
    method: "pebble/event",
    params: { k: 1 },
  });
  assert.deepEqual(rpcResponse(7, null), {
    jsonrpc: "2.0",
    id: 7,
    result: null,
  });
  assert.deepEqual(
    rpcErrorResponse(null, -32700, "parse error"),
    {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "parse error" },
    },
  );
});

test("rpc guards accept valid messages only", () => {
  assert.ok(isRpcRequest(rpcRequest(1, "m")));
  assert.ok(isRpcNotification(rpcNotification("m")));
  assert.ok(isRpcResponse(rpcResponse(1, 2)));
  assert.ok(isRpcResponse(rpcErrorResponse(1, -32603, "boom")));
  assert.ok(!isRpcResponse({ jsonrpc: "2.0", id: 1 })); // neither result nor error
  assert.ok(!isRpcResponse({ jsonrpc: "2.0", id: 1, result: 1, error: {} })); // both
  assert.ok(!isRpcRequest({ jsonrpc: "2.0", method: "m" })); // no id
  assert.ok(!isRpcNotification({ jsonrpc: "1.0", method: "m" }));
  assert.ok(!isRpcRequest({ jsonrpc: "2.0", id: 1, method: "" }));
  assert.ok(!isRpcResponse({ jsonrpc: "2.0", id: 1, error: { code: "x", message: "m" } }));
  assert.ok(!isRpcMessage("nope"));
});

test("event notification wrap/unwrap validates fail-closed", () => {
  const event = {
    v: 1,
    seq: 0,
    ts: "2026-08-25T09:30:00.000Z",
    sessionId: "s1",
    kind: "turn.start",
  } as const;
  const msg = eventNotification(event);
  assert.equal(msg.method, EVENT_NOTIFICATION_METHOD);
  const unwrapped = unwrapEvent(msg);
  assert.ok(unwrapped !== null && unwrapped.kind === "turn.start");

  assert.equal(unwrapEvent(rpcNotification("other/method", event)), null);
  // Invalid params under our method name = protocol violation, not an event:
  assert.equal(
    unwrapEvent(rpcNotification(EVENT_NOTIFICATION_METHOD, { kind: "nope" })),
    null,
  );
  assert.equal(unwrapEvent({ nope: true }), null);

  // Full pipe: encode → decode → unwrap yields the validated event.
  const frames = decodeFrames(encodeFrame(eventNotification(event)));
  assert.ok(frames.length === 1 && unwrapEvent(frames[0]) !== null);
});

test("RPC_ERROR_CODES carry reserved JSON-RPC values", () => {
  assert.deepEqual(RPC_ERROR_CODES, {
    PARSE_ERROR: -32700,
    INVALID_REQUEST: -32600,
    METHOD_NOT_FOUND: -32601,
    INVALID_PARAMS: -32602,
    INTERNAL_ERROR: -32603,
  });
});
