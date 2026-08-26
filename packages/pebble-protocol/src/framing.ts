/**
 * PEBBLE JSONL-RPC framing — VERSION 1, FROZEN.
 *
 * THE FRAMING RULE: frames are separated STRICTLY by the newline byte 0x0A.
 * Nothing else is a separator. This decoder accumulates raw bytes manually and
 * never uses Node's readline for protocol parsing, because of the trap below.
 *
 * ── THE NODE READLINE TRAP ───────────────────────────────────────────────────
 * Node's `readline` splits on \n, \r\n — AND on U+2028 (LINE SEPARATOR) and
 * U+2029 (PARAGRAPH SEPARATOR). Meanwhile JSON.stringify emits U+2028/U+2029
 * RAW inside string values (they are legal JSON string characters and are not
 * re-escaped). So a readline-based JSONL pipe corrupts any frame whose BODY
 * contains U+2028/U+2029: readline splits mid-frame at those code points and
 * both halves fail to parse. This decoder works on bytes and splits ONLY on
 * 0x0A (which UTF-8 guarantees can never appear inside a multi-byte sequence),
 * so frames whose body contains U+2028/U+2029 survive intact. The golden
 * fixture fixtures/delta.text.json contains both characters raw in its text
 * field precisely to prove this. Never replace this decoder with readline.
 *
 * Other rules:
 * - \r is NOT a terminator. Frames terminated "\r\n" still parse because a
 *   trailing \r is legal JSON whitespace OUTSIDE string values, so CRLF-
 *   speaking peers interoperate — but the \r is gone after one round-trip
 *   (re-encoding never emits it), so byte-stable hops REQUIRE bare-LF
 *   frames. A RAW CR byte inside a string value is illegal JSON and fails
 *   loudly; producers never hit this because JSON.stringify escapes CRs.
 * - Blank lines (zero bytes or whitespace only between two newlines) are
 *   skipped silently. Any other unparseable frame throws.
 * - Incomplete trailing data is held until more arrives; end() fails loudly if
 *   called with unparsed bytes still buffered.
 * - Invalid UTF-8 fails closed (fatal TextDecoder), as does exceeding
 *   maxFrameBytes — a broken or hostile peer cannot buffer-bomb the process.
 */

import { isTurnEvent, type TurnEvent } from "./events.ts";

const NEWLINE = 0x0a;

/** Default cap for one frame's byte size (16 MiB). */
export const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024;

export type ProtocolErrorCode =
  | "bad-json"
  | "bad-utf8"
  | "frame-too-large"
  | "trailing-bytes";

/** Loud failure of framing or serialization. Always carries an error code. */
export class ProtocolError extends Error {
  readonly code: ProtocolErrorCode;

  constructor(
    code: ProtocolErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export interface JsonlDecoderOptions {
  /** Maximum buffered size of one incomplete frame. Default 16 MiB. */
  maxFrameBytes?: number | undefined;
}

/**
 * Incremental byte-accurate JSONL decoder. Feed it chunks from any source
 * (stdin, socket, file); it returns fully parsed frames in order as soon as
 * their terminating newlines arrive.
 */
export class JsonlDecoder {
  #buf: Uint8Array;
  #len = 0; // used bytes in #buf
  #scanned = 0; // index up to which we've searched for a newline
  #framesSeen = 0;
  #byteBase = 0; // absolute stream offset of buf[0]
  readonly #maxFrameBytes: number;

  constructor(options: JsonlDecoderOptions = {}) {
    this.#maxFrameBytes =
      options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    this.#buf = new Uint8Array(4096);
  }

  /**
   * Feed one chunk (bytes or a JS string, which is encoded as UTF-8 first).
   * Returns every frame that completed with this push, parsed, in order.
   * Throws {@link ProtocolError} on invalid JSON/UTF-8 or frame-size overrun.
   */
  push(chunk: Uint8Array | string): unknown[] {
    const bytes =
      typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
    this.#grow(bytes.length);
    this.#buf.set(bytes, this.#len);
    this.#len += bytes.length;

    const out: unknown[] = [];
    let i = this.#scanned;
    let frameStart = 0;
    for (;;) {
      const nl = this.#indexOfByte(NEWLINE, i);
      if (nl === -1) break;
      const frame = this.#buf.subarray(frameStart, nl);
      this.#framesSeen += 1;
      const parsed = this.#parseFrame(frame);
      if (parsed !== undefined) out.push(parsed);
      i = nl + 1;
      frameStart = nl + 1;
    }
    this.#scanned = i;

    // Compact surviving partial-frame bytes to the front.
    if (frameStart > 0) {
      this.#buf.copyWithin(0, frameStart, this.#len);
      this.#len -= frameStart;
      this.#scanned -= frameStart;
      this.#byteBase += frameStart;
    }

    // Reachable only when NO newline exists anywhere in the buffer: a producer
    // streaming an oversized frame without terminators gets stopped here
    // instead of growing memory without bound.
    if (this.#len > this.#maxFrameBytes) {
      throw new ProtocolError(
        "frame-too-large",
        `frame exceeds maxFrameBytes (${this.#maxFrameBytes}) without a newline`,
      );
    }
    return out;
  }

  /**
   * Signal clean end-of-stream. Fails loudly when unparsed bytes remain —
   * a truncated final frame means the peer died mid-write, not "end of input".
   */
  end(): void {
    if (this.#len > 0) {
      throw new ProtocolError(
        "trailing-bytes",
        `${this.#len} unparsed byte(s) after last newline`,
      );
    }
  }

  /** Bytes currently held awaiting their terminating newline. */
  get buffered(): number {
    return this.#len;
  }

  /**
   * Absolute byte offset of the next unparsed frame start in the stream.
   * Between pushes this equals the start of the currently buffered partial
   * frame (everything before it has been emitted or skipped).
   */
  get streamOffset(): number {
    return this.#byteBase;
  }

  #grow(extra: number): void {
    if (this.#len + extra <= this.#buf.length) return;
    let capacity = Math.max(this.#len + extra, this.#buf.length * 2);
    while (capacity < this.#len + extra) capacity *= 2;
    const next = new Uint8Array(capacity);
    next.set(this.#buf.subarray(0, this.#len));
    this.#buf = next;
  }

  #indexOfByte(byte: number, from: number): number {
    for (let i = Math.max(from, 0); i < this.#len; i++) {
      if (this.#buf[i] === byte) return i;
    }
    return -1;
  }

  #parseFrame(frame: Uint8Array): unknown | undefined {
    if (frame.length > this.#maxFrameBytes) {
      throw new ProtocolError(
        "frame-too-large",
        `frame ${this.#framesSeen} exceeds maxFrameBytes (${this.#maxFrameBytes})`,
      );
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(frame);
    } catch (err) {
      throw new ProtocolError(
        "bad-utf8",
        `frame ${this.#framesSeen} at byte ${this.#byteBase} is not valid UTF-8`,
        { cause: err },
      );
    }
    if (text.trim().length === 0) return undefined; // blank line: tolerated
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new ProtocolError(
        "bad-json",
        `frame ${this.#framesSeen} at byte ${this.#byteBase} is not valid JSON`,
        { cause: err },
      );
    }
  }
}

/** Serialize one value as a canonical JSONL frame string ("{...}\n"). */
export function encodeFrameText(value: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch (err) {
    throw new ProtocolError("bad-json", "value is not JSON-serializable", {
      cause: err,
    });
  }
  return `${json}\n`;
}

/** Serialize one value to UTF-8 frame bytes ready for the wire. */
export function encodeFrame(value: unknown): Uint8Array {
  return new TextEncoder().encode(encodeFrameText(value));
}

/** One-shot decode: parse all complete frames in a buffer, then verify clean EOF. */
export function decodeFrames(
  bytes: Uint8Array,
  options: JsonlDecoderOptions = {},
): unknown[] {
  const decoder = new JsonlDecoder(options);
  const frames = decoder.push(bytes);
  decoder.end();
  return frames;
}

// ---------------------------------------------------------------------------
// RPC envelopes (JSON-RPC 2.0 subset)
// ---------------------------------------------------------------------------

export interface RpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

export interface RpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface RpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface RpcResponse {
  jsonrpc: "2.0";
  /** null only when the request id could not be determined (JSON-RPC spec). */
  id: number | string | null;
  result?: unknown;
  error?: RpcErrorObject;
}

export type RpcMessage = RpcRequest | RpcNotification | RpcResponse;

/** Reserved JSON-RPC error codes used by Pebble RPC mode. */
export const RPC_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

export function rpcRequest(
  id: number | string,
  method: string,
  params?: unknown,
): RpcRequest {
  return params !== undefined
    ? { jsonrpc: "2.0", id, method, params }
    : { jsonrpc: "2.0", id, method };
}

export function rpcNotification(
  method: string,
  params?: unknown,
): RpcNotification {
  return params !== undefined
    ? { jsonrpc: "2.0", method, params }
    : { jsonrpc: "2.0", method };
}

export function rpcResponse(id: number | string, result: unknown): RpcResponse {
  return { jsonrpc: "2.0", id, result };
}

export function rpcErrorResponse(
  id: number | string | null,
  code: number,
  message: string,
  data?: unknown,
): RpcResponse {
  return data !== undefined
    ? { jsonrpc: "2.0", id, error: { code, message, data } }
    : { jsonrpc: "2.0", id, error: { code, message } };
}

function isRpcRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasVersion(record: Record<string, unknown>): boolean {
  return record["jsonrpc"] === "2.0";
}

function isValidId(id: unknown): boolean {
  return typeof id === "number" || typeof id === "string";
}

export function isRpcRequest(value: unknown): value is RpcRequest {
  if (!isRpcRecord(value)) return false;
  return (
    hasVersion(value) &&
    isValidId(value["id"]) &&
    typeof value["method"] === "string" &&
    value["method"].length > 0 &&
    !("result" in value) &&
    !("error" in value)
  );
}

export function isRpcNotification(value: unknown): value is RpcNotification {
  if (!isRpcRecord(value)) return false;
  return (
    hasVersion(value) &&
    !("id" in value) &&
    typeof value["method"] === "string" &&
    value["method"].length > 0 &&
    !("result" in value) &&
    !("error" in value)
  );
}

function isValidRpcErrorObject(value: unknown): boolean {
  if (!isRpcRecord(value)) return false;
  if (typeof value["code"] !== "number") return false;
  if (typeof value["message"] !== "string") return false;
  return !("data" in value) || value["data"] !== undefined;
}

export function isRpcResponse(value: unknown): value is RpcResponse {
  if (!isRpcRecord(value)) return false;
  if (!hasVersion(value)) return false;
  const id: unknown = value["id"];
  if (!(id === null || isValidId(id))) return false;
  const hasResult = "result" in value && value["result"] !== undefined;
  const hasError = "error" in value && value["error"] !== undefined;
  if (hasResult === hasError) return false; // exactly one of result/error
  if (hasError && !isValidRpcErrorObject(value["error"])) return false;
  return true;
}

export function isRpcMessage(value: unknown): value is RpcMessage {
  return (
    isRpcNotification(value) || isRpcRequest(value) || isRpcResponse(value)
  );
}

// ---------------------------------------------------------------------------
// Event channel over RPC mode
// ---------------------------------------------------------------------------

/**
 * Method name carrying turn events in RPC mode: each event rides one
 * notification whose `params` IS the event object.
 */
export const EVENT_NOTIFICATION_METHOD = "pebble/event";

/** Wrap a turn event as an RPC-mode notification frame. */
export function eventNotification(event: TurnEvent): RpcNotification {
  return rpcNotification(EVENT_NOTIFICATION_METHOD, event);
}

/**
 * Extract a turn event from a decoded RPC message. Returns the validated
 * event, or null when the message isn't an pebble/event notification or its
 * params fail validation (protocol violation — callers should log loudly).
 */
export function unwrapEvent(message: unknown): TurnEvent | null {
  if (!isRpcNotification(message)) return null;
  if (message.method !== EVENT_NOTIFICATION_METHOD) return null;
  const event: unknown = message.params;
  return isTurnEvent(event) ? event : null;
}
