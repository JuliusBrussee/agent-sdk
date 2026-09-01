import {
  snapshotDataDictionary,
  snapshotDataRecord,
  snapshotDenseArray,
} from "./strict-data.js";
import { abortable } from "./async-boundary.js";

export const AGENT_INPUT_MAX_PARTS = 64;
export const AGENT_INPUT_MAX_TEXT_BYTES = 1024 * 1024;
export const AGENT_INPUT_MAX_BASE64_BYTES_PER_PART = 32 * 1024 * 1024;
export const AGENT_INPUT_MAX_BASE64_BYTES_TOTAL = 64 * 1024 * 1024;
export const AGENT_INPUT_MAX_URL_LENGTH = 8_192;
export const AGENT_INPUT_MAX_MIME_LENGTH = 127;
export const AGENT_INPUT_MAX_FILE_NAME_LENGTH = 255;
const FINITE_JSON_MAX_BYTES = 64 * 1024;
const FINITE_JSON_MAX_DEPTH = 16;
const FINITE_JSON_MAX_ENTRIES = 1_024;

export type FiniteJSON =
  | null
  | boolean
  | number
  | string
  | readonly FiniteJSON[]
  | { readonly [key: string]: FiniteJSON };

export interface AgentInputURLSource {
  readonly type: "url";
  readonly url: string;
}

export interface AgentInputBase64Source {
  readonly type: "base64";
  readonly data: string;
}

export type AgentInputSource = AgentInputURLSource | AgentInputBase64Source;

export interface AgentTextInputPart {
  readonly type: "text";
  readonly text: string;
}

export interface AgentImageInputPart {
  readonly type: "image";
  readonly mimeType: string;
  readonly source: AgentInputSource;
}

export interface AgentAudioInputPart {
  readonly type: "audio";
  readonly mimeType: string;
  readonly source: AgentInputSource;
}

export interface AgentFileInputPart {
  readonly type: "file";
  readonly mimeType: string;
  readonly source: AgentInputSource;
  readonly name?: string;
}

export interface AgentOpaqueInputPart {
  readonly type: "opaque";
  readonly provider: string;
  readonly value: FiniteJSON;
}

export type AgentInputPart =
  | AgentTextInputPart
  | AgentImageInputPart
  | AgentAudioInputPart
  | AgentFileInputPart
  | AgentOpaqueInputPart;

export type AgentInput = string | readonly AgentInputPart[];

export interface NormalizedAgentInput {
  readonly parts: readonly AgentInputPart[];
  readonly textBytes: number;
  readonly base64Bytes: number;
  readonly remoteReferences: number;
}

export interface AgentInputEncoder<Output> {
  readonly id: string;
  /** Pure capability check. Called for every part before `encode`. */
  readonly supports: (part: AgentInputPart) => boolean;
  /** Encodes normalized data only. URL retrieval remains provider/host-owned. */
  readonly encode: (
    input: NormalizedAgentInput,
    signal: AbortSignal,
  ) => Output | Promise<Output>;
}

function normalizeFiniteJSON(value: unknown): FiniteJSON {
  const tracker = { entries: 0, rawCharacters: 0 };
  const active = new Set<object>();
  const copy = copyJSONValue(value, 0, tracker, active);
  if (Buffer.byteLength(serializeFiniteJSON(copy), "utf8") > FINITE_JSON_MAX_BYTES) {
    throw new Error("cave_finite_json_bytes_limit");
  }
  return copy;
}

function serializeFiniteJSON(value: FiniteJSON): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(serializeFiniteJSON).join(",")}]`;
  const record = value as Readonly<Record<string, FiniteJSON>>;
  return `{${Object.keys(record)
    .map((key) => `${JSON.stringify(key)}:${serializeFiniteJSON(record[key]!)}`)
    .join(",")}}`;
}

function copyJSONValue(
  value: unknown,
  depth: number,
  tracker: { entries: number; rawCharacters: number },
  active: Set<object>,
): FiniteJSON {
  if (depth > FINITE_JSON_MAX_DEPTH) throw new Error("cave_finite_json_depth_limit");
  tracker.entries++;
  if (tracker.entries > FINITE_JSON_MAX_ENTRIES) {
    throw new Error("cave_finite_json_entries_limit");
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    addRawCharacters(tracker, value.length);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("cave_finite_json_non_finite");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") throw new Error("cave_finite_json_non_json");
  if (active.has(value)) throw new Error("cave_finite_json_cycle");
  active.add(value);
  try {
    if (Array.isArray(value)) {
      const items = snapshotDenseArray(
        value,
        FINITE_JSON_MAX_ENTRIES,
        () => { throw new Error("cave_finite_json_non_json"); },
      );
      if (tracker.entries + items.length > FINITE_JSON_MAX_ENTRIES) {
        throw new Error("cave_finite_json_entries_limit");
      }
      return Object.freeze(items.map((item) => copyJSONValue(item, depth + 1, tracker, active)));
    }
    const record = snapshotDataDictionary(
      value,
      FINITE_JSON_MAX_ENTRIES,
      () => { throw new Error("cave_finite_json_non_json"); },
    );
    const copy: Record<string, FiniteJSON> = {};
    for (const key of Object.keys(record)) {
      addRawCharacters(tracker, key.length);
      Object.defineProperty(copy, key, {
        value: copyJSONValue(record[key], depth + 1, tracker, active),
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
    return Object.freeze(copy);
  } finally {
    active.delete(value);
  }
}

function addRawCharacters(
  tracker: { entries: number; rawCharacters: number },
  count: number,
): void {
  tracker.rawCharacters += count;
  if (tracker.rawCharacters > FINITE_JSON_MAX_BYTES) {
    throw new Error("cave_finite_json_bytes_limit");
  }
}

const TEXT_KEYS = Object.freeze(["type", "text"]);
const MEDIA_KEYS = Object.freeze(["type", "mimeType", "source"]);
const FILE_KEYS = Object.freeze(["type", "mimeType", "source", "name"]);
const FILE_REQUIRED_KEYS = Object.freeze(["type", "mimeType", "source"]);
const OPAQUE_KEYS = Object.freeze(["type", "provider", "value"]);
const PART_KEYS = Object.freeze([
  "type",
  "text",
  "mimeType",
  "source",
  "name",
  "provider",
  "value",
]);
const URL_SOURCE_KEYS = Object.freeze(["type", "url"]);
const BASE64_SOURCE_KEYS = Object.freeze(["type", "data"]);
const SOURCE_KEYS = Object.freeze(["type", "url", "data"]);
const ENCODER_KEYS = Object.freeze(["id", "supports", "encode"]);
const ENCODER_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,63})$/;
const PROVIDER_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,127})$/;
const MIME = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/;
const NEVER_ABORTS = new AbortController().signal;

export function normalizeAgentInput(input: AgentInput): NormalizedAgentInput {
  const candidates: unknown[] = [];
  if (typeof input === "string") {
    candidates.push(Object.freeze({ type: "text" as const, text: input }));
  } else {
    const snapshot = snapshotDenseArray(
      input,
      AGENT_INPUT_MAX_PARTS,
      () => { throw new Error("cave_input_parts_invalid"); },
    );
    for (const item of snapshot) candidates.push(item);
  }
  if (candidates.length === 0 || candidates.length > AGENT_INPUT_MAX_PARTS) {
    throw new Error("cave_input_parts_invalid");
  }

  const parts: AgentInputPart[] = [];
  let textBytes = 0;
  let base64Bytes = 0;
  let remoteReferences = 0;
  for (let index = 0; index < candidates.length; index++) {
    const normalized = normalizePart(candidates[index], index);
    parts.push(normalized.part);
    textBytes += normalized.textBytes;
    base64Bytes += normalized.base64Bytes;
    remoteReferences += normalized.remoteReferences;
    if (textBytes > AGENT_INPUT_MAX_TEXT_BYTES) throw new Error("cave_input_text_bytes_limit");
    if (base64Bytes > AGENT_INPUT_MAX_BASE64_BYTES_TOTAL) {
      throw new Error("cave_input_base64_total_bytes_limit");
    }
  }
  return Object.freeze({
    parts: Object.freeze(parts),
    textBytes,
    base64Bytes,
    remoteReferences,
  });
}

export function defineAgentInputEncoder<Output>(
  encoder: AgentInputEncoder<Output>,
): AgentInputEncoder<Output> {
  const snapshot = snapshotDataRecord(
    encoder,
    ENCODER_KEYS,
    ENCODER_KEYS,
    () => { throw new Error("cave_input_encoder_invalid"); },
  );
  if (typeof snapshot["id"] !== "string" || !ENCODER_ID.test(snapshot["id"]) ||
      typeof snapshot["supports"] !== "function" || typeof snapshot["encode"] !== "function") {
    throw new Error("cave_input_encoder_invalid");
  }
  return Object.freeze({
    id: snapshot["id"],
    supports: snapshot["supports"] as AgentInputEncoder<Output>["supports"],
    encode: snapshot["encode"] as AgentInputEncoder<Output>["encode"],
  });
}

/** Normalizes once, preflights every part, then invokes one selected encoder. */
export async function encodeAgentInput<Output>(
  input: AgentInput,
  selectedEncoder: AgentInputEncoder<Output>,
  signal: AbortSignal = NEVER_ABORTS,
): Promise<Output> {
  const encoder = defineAgentInputEncoder(selectedEncoder);
  if (!(signal instanceof AbortSignal)) throw new Error("cave_input_signal_invalid");
  throwIfAborted(signal);
  const normalized = normalizeAgentInput(input);
  const unsupported: number[] = [];
  const supportErrors: unknown[] = [];
  for (let index = 0; index < normalized.parts.length; index++) {
    throwIfAborted(signal);
    try {
      const supported = encoder.supports(normalized.parts[index]!);
      if (typeof supported !== "boolean") {
        supportErrors.push(new Error(`cave_input_encoder_support_invalid:${index}`));
      } else if (!supported) {
        unsupported.push(index);
      }
    } catch (error) {
      supportErrors.push(error);
    }
  }
  if (supportErrors.length > 0) {
    throw new AggregateError(supportErrors, "cave_input_encoder_support_failed");
  }
  if (unsupported.length > 0) {
    throw new Error(`cave_input_unsupported:${encoder.id}:${unsupported.join(",")}`);
  }
  throwIfAborted(signal);
  return await abortable(
    Promise.resolve().then(() => encoder.encode(normalized, signal)),
    signal,
    () => inputAbortError(signal),
  );
}

function normalizePart(
  value: unknown,
  index: number,
): { part: AgentInputPart; textBytes: number; base64Bytes: number; remoteReferences: number } {
  const candidate = snapshotDataRecord(
    value,
    PART_KEYS,
    ["type"],
    () => { throw new Error(`cave_input_part_invalid:${index}`); },
  );
  if (candidate["type"] === "text") {
    const part = snapshotDataRecord(
      candidate,
      TEXT_KEYS,
      TEXT_KEYS,
      () => { throw new Error(`cave_input_part_invalid:${index}`); },
    );
    if (typeof part["text"] !== "string") {
      throw new Error(`cave_input_part_invalid:${index}`);
    }
    const textBytes = Buffer.byteLength(part["text"], "utf8");
    if (textBytes > AGENT_INPUT_MAX_TEXT_BYTES) throw new Error("cave_input_text_bytes_limit");
    return {
      part: Object.freeze({ type: "text", text: part["text"] }),
      textBytes,
      base64Bytes: 0,
      remoteReferences: 0,
    };
  }
  if (candidate["type"] === "opaque") {
    const part = snapshotDataRecord(
      candidate,
      OPAQUE_KEYS,
      OPAQUE_KEYS,
      () => { throw new Error(`cave_input_part_invalid:${index}`); },
    );
    if (typeof part["provider"] !== "string" || !PROVIDER_ID.test(part["provider"])) {
      throw new Error(`cave_input_part_invalid:${index}`);
    }
    return {
      part: Object.freeze({
        type: "opaque",
        provider: part["provider"],
        value: normalizeFiniteJSON(part["value"]),
      }),
      textBytes: 0,
      base64Bytes: 0,
      remoteReferences: 0,
    };
  }
  if (candidate["type"] !== "image" && candidate["type"] !== "audio" &&
      candidate["type"] !== "file") {
    throw new Error(`cave_input_part_invalid:${index}`);
  }
  const allowed = candidate["type"] === "file" ? FILE_KEYS : MEDIA_KEYS;
  const required = candidate["type"] === "file" ? FILE_REQUIRED_KEYS : MEDIA_KEYS;
  const part = snapshotDataRecord(
    candidate,
    allowed,
    required,
    () => { throw new Error(`cave_input_part_invalid:${index}`); },
  );
  if (!isMimeType(part["mimeType"]) ||
      (candidate["type"] === "image" && !part["mimeType"].toLowerCase().startsWith("image/")) ||
      (candidate["type"] === "audio" && !part["mimeType"].toLowerCase().startsWith("audio/"))) {
    throw new Error(`cave_input_part_invalid:${index}`);
  }
  const fileName = Object.hasOwn(part, "name") ? part["name"] : undefined;
  if (candidate["type"] === "file" && fileName !== undefined && !isFileName(fileName)) {
    throw new Error(`cave_input_file_name_invalid:${index}`);
  }
  const source = normalizeSource(part["source"], index);
  if ((candidate["type"] === "image" || candidate["type"] === "audio") &&
      source.source.type === "base64" && source.base64Bytes === 0) {
    throw new Error(`cave_input_base64_empty:${index}`);
  }
  const common = {
    type: candidate["type"],
    mimeType: part["mimeType"],
    source: source.source,
  } as const;
  const normalizedPart: AgentInputPart = candidate["type"] === "file"
    ? Object.freeze({ ...common, type: "file", name: fileName }) as AgentFileInputPart
    : Object.freeze(common) as AgentInputPart;
  return {
    part: normalizedPart,
    textBytes: 0,
    base64Bytes: source.base64Bytes,
    remoteReferences: source.remoteReferences,
  };
}

function normalizeSource(
  value: unknown,
  partIndex: number,
): { source: AgentInputSource; base64Bytes: number; remoteReferences: number } {
  const candidate = snapshotDataRecord(
    value,
    SOURCE_KEYS,
    ["type"],
    () => { throw new Error(`cave_input_source_invalid:${partIndex}`); },
  );
  if (candidate["type"] === "url") {
    const source = snapshotDataRecord(
      candidate,
      URL_SOURCE_KEYS,
      URL_SOURCE_KEYS,
      () => { throw new Error(`cave_input_url_invalid:${partIndex}`); },
    );
    if (!isRemoteURL(source["url"])) {
      throw new Error(`cave_input_url_invalid:${partIndex}`);
    }
    return {
      source: Object.freeze({ type: "url", url: source["url"] }),
      base64Bytes: 0,
      remoteReferences: 1,
    };
  }
  if (candidate["type"] === "base64") {
    const source = snapshotDataRecord(
      candidate,
      BASE64_SOURCE_KEYS,
      BASE64_SOURCE_KEYS,
      () => { throw new Error(`cave_input_base64_invalid:${partIndex}`); },
    );
    if (typeof source["data"] !== "string" || source["data"].length % 4 !== 0) {
      throw new Error(`cave_input_base64_invalid:${partIndex}`);
    }
    const bytes = decodedBase64Length(source["data"]);
    if (bytes > AGENT_INPUT_MAX_BASE64_BYTES_PER_PART) {
      throw new Error("cave_input_base64_part_bytes_limit");
    }
    if (!isCanonicalBase64(source["data"])) {
      throw new Error(`cave_input_base64_invalid:${partIndex}`);
    }
    return {
      source: Object.freeze({ type: "base64", data: source["data"] }),
      base64Bytes: bytes,
      remoteReferences: 0,
    };
  }
  throw new Error(`cave_input_source_invalid:${partIndex}`);
}

function isRemoteURL(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 ||
      value.length > AGENT_INPUT_MAX_URL_LENGTH || value.trim() !== value ||
      /[\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      parsed.hostname !== "" && parsed.username === "" && parsed.password === "";
  } catch {
    return false;
  }
}

function isMimeType(value: unknown): value is string {
  return typeof value === "string" && value.length <= AGENT_INPUT_MAX_MIME_LENGTH &&
    MIME.test(value);
}

function isFileName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= AGENT_INPUT_MAX_FILE_NAME_LENGTH && value.trim() === value &&
    !/[\/\\\u0000-\u001f\u007f]/.test(value) && value !== "." && value !== "..";
}

function isCanonicalBase64(value: string): boolean {
  if (value.length % 4 !== 0) return false;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const contentLength = value.length - padding;
  for (let index = 0; index < contentLength; index++) {
    if (base64Value(value.charCodeAt(index)) < 0) return false;
  }
  for (let index = contentLength; index < value.length; index++) {
    if (value.charCodeAt(index) !== 61) return false;
  }
  if (padding === 2) {
    const sextet = base64Value(value.charCodeAt(value.length - 3));
    return sextet >= 0 && (sextet & 0b1111) === 0;
  }
  if (padding === 1) {
    const sextet = base64Value(value.charCodeAt(value.length - 2));
    return sextet >= 0 && (sextet & 0b11) === 0;
  }
  return true;
}

function base64Value(code: number): number {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  if (code === 43) return 62;
  if (code === 47) return 63;
  return -1;
}

function decodedBase64Length(value: string): number {
  if (value.length === 0) return 0;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw inputAbortError(signal);
}

function inputAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("cave_input_aborted");
}
