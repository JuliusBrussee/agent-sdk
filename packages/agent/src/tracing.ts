import {
  ADAPTER_LIFECYCLE_PHASES,
  type AdapterLifecyclePhase,
} from "@caveman-ai/adapter-kit";
import { snapshotDataDictionary, snapshotDataRecord, snapshotDenseArray } from "./strict-data.js";

export const TRACE_EVENT_NAMES = Object.freeze([
  ...ADAPTER_LIFECYCLE_PHASES,
  "model.routed",
  "model.retry",
  "cache.epoch.rotated",
  "checkpoint.restored",
] as const);

export const TRACE_ATTRIBUTE_NAMES = Object.freeze([
  "caveman.run.id",
  "caveman.step.id",
  "caveman.model.call.id",
  "caveman.tool.call.id",
  "caveman.attempt",
  "caveman.replay",
  "caveman.cache.epoch",
  "caveman.route.signals",
  "caveman.accounting.status",
  "caveman.runtime.containment",
  "gen_ai.system",
  "gen_ai.operation.name",
  "gen_ai.request.model",
  "gen_ai.response.model",
  "gen_ai.usage.input_tokens",
  "gen_ai.usage.output_tokens",
  "gen_ai.usage.cache_read_tokens",
  "gen_ai.usage.cache_write_tokens",
  "gen_ai.usage.reasoning_tokens",
  "error.type",
] as const);

export type TraceEventName = AdapterLifecyclePhase |
  "model.routed" |
  "model.retry" |
  "cache.epoch.rotated" |
  "checkpoint.restored";
export type TraceAttributeName = typeof TRACE_ATTRIBUTE_NAMES[number];
export type TraceAttributeValue = string | number | boolean | readonly string[];

export interface TraceEventRecord {
  readonly name: TraceEventName;
  readonly atUnixNano: string;
  readonly attributes?: Readonly<Partial<Record<TraceAttributeName, TraceAttributeValue>>>;
}

export interface TraceSpanRecord {
  readonly schemaVersion: 1;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: "agent.run" | "agent.model" | "agent.tool" | "agent.checkpoint";
  readonly kind: "internal" | "client";
  readonly startUnixNano: string;
  readonly endUnixNano: string;
  readonly status: "unset" | "ok" | "error";
  readonly attributes: Readonly<Partial<Record<TraceAttributeName, TraceAttributeValue>>>;
  readonly events: readonly TraceEventRecord[];
}

export interface TraceBridge {
  emit(span: Readonly<TraceSpanRecord>): void | PromiseLike<void>;
  flush?(signal?: AbortSignal): void | PromiseLike<void>;
}

export interface TraceEmitOptions {
  readonly sampleRate?: number;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export type TraceEmitResult = "emitted" | "sampled_out" | "bridge_failed" | "aborted" | "timed_out";
export type TraceFlushResult = "flushed" | "unsupported" | "failed" | "aborted" | "timed_out";

const SPAN_KEYS = Object.freeze([
  "schemaVersion",
  "traceId",
  "spanId",
  "parentSpanId",
  "name",
  "kind",
  "startUnixNano",
  "endUnixNano",
  "status",
  "attributes",
  "events",
]);
const EVENT_KEYS = Object.freeze(["name", "atUnixNano", "attributes"]);
const EMIT_OPTION_KEYS = Object.freeze(["sampleRate", "signal", "timeoutMs"]);
const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;
const UNIX_NANO = /^(?:0|[1-9][0-9]{0,29})$/;
const SPAN_NAMES = Object.freeze(["agent.run", "agent.model", "agent.tool", "agent.checkpoint"]);
const SPAN_KINDS = Object.freeze(["internal", "client"]);
const SPAN_STATUSES = Object.freeze(["unset", "ok", "error"]);
const EVENT_NAMES = new Set<string>(TRACE_EVENT_NAMES);
const ATTRIBUTE_NAMES = new Set<string>(TRACE_ATTRIBUTE_NAMES);
const NUMBER_ATTRIBUTES = new Set<string>([
  "caveman.attempt",
  "gen_ai.usage.input_tokens",
  "gen_ai.usage.output_tokens",
  "gen_ai.usage.cache_read_tokens",
  "gen_ai.usage.cache_write_tokens",
  "gen_ai.usage.reasoning_tokens",
]);
const BOOLEAN_ATTRIBUTES = new Set<string>(["caveman.replay"]);
const ARRAY_ATTRIBUTES = new Set<string>(["caveman.route.signals"]);
const MAX_ATTRIBUTES = 64;
const MAX_EVENTS = 128;
const MAX_ATTRIBUTE_STRING = 512;
const MAX_ATTRIBUTE_ARRAY = 64;
const MAX_EMIT_TIMEOUT_MS = 30_000;
const MAX_FLUSH_TIMEOUT_MS = 30_000;

/** Validate a completed, content-blind span and detach all caller containers. */
export function defineTraceSpanRecord(value: unknown): TraceSpanRecord {
  const span = snapshotRecord(value, SPAN_KEYS, [
    "schemaVersion",
    "traceId",
    "spanId",
    "name",
    "kind",
    "startUnixNano",
    "endUnixNano",
    "status",
    "attributes",
    "events",
  ], "span");
  if (span.schemaVersion !== 1 || typeof span.traceId !== "string" ||
      !TRACE_ID.test(span.traceId) || /^0+$/.test(span.traceId) ||
      typeof span.spanId !== "string" || !SPAN_ID.test(span.spanId) ||
      /^0+$/.test(span.spanId)) {
    fail("identity");
  }
  if (span.parentSpanId !== undefined &&
      (typeof span.parentSpanId !== "string" || !SPAN_ID.test(span.parentSpanId) ||
        /^0+$/.test(span.parentSpanId) || span.parentSpanId === span.spanId)) {
    fail("parent_span_id");
  }
  requireOneOf(span.name, SPAN_NAMES, "name");
  requireOneOf(span.kind, SPAN_KINDS, "kind");
  requireOneOf(span.status, SPAN_STATUSES, "status");
  const start = normalizeUnixNano(span.startUnixNano, "start");
  const end = normalizeUnixNano(span.endUnixNano, "end");
  if (BigInt(end) < BigInt(start)) fail("time_order");
  const attributes = normalizeAttributes(span.attributes);
  const eventValues = snapshotDenseArray(span.events, MAX_EVENTS, () => fail("events"));
  let previousEventTime = start;
  const events = eventValues.map((eventValue) => {
    const event = normalizeEvent(eventValue, start, end);
    if (BigInt(event.atUnixNano) < BigInt(previousEventTime)) fail("event_time_order");
    previousEventTime = event.atUnixNano;
    return event;
  });
  return Object.freeze({
    schemaVersion: 1,
    traceId: span.traceId,
    spanId: span.spanId,
    ...(span.parentSpanId === undefined ? {} : { parentSpanId: span.parentSpanId as string }),
    name: span.name as TraceSpanRecord["name"],
    kind: span.kind as TraceSpanRecord["kind"],
    startUnixNano: start,
    endUnixNano: end,
    status: span.status as TraceSpanRecord["status"],
    attributes,
    events: Object.freeze(events),
  });
}

/** Emit once. Sampling and bridge failures never change agent execution. */
export async function emitTraceSpan(
  bridge: TraceBridge,
  spanValue: TraceSpanRecord,
  options: TraceEmitOptions = {},
): Promise<TraceEmitResult> {
  const emit = requireBridgeMethod(bridge, "emit") as TraceBridge["emit"];
  const normalizedOptions = snapshotRecord(options, EMIT_OPTION_KEYS, [], "emit_options");
  const sampleRate = normalizedOptions.sampleRate ?? 1;
  if (typeof sampleRate !== "number" || !Number.isFinite(sampleRate) ||
      sampleRate < 0 || sampleRate > 1) {
    fail("sample_rate");
  }
  if (normalizedOptions.signal !== undefined &&
      !(normalizedOptions.signal instanceof AbortSignal)) {
    fail("signal");
  }
  const signal = normalizedOptions.signal as AbortSignal | undefined;
  const timeoutValue = normalizedOptions.timeoutMs ?? 250;
  if (typeof timeoutValue !== "number" || !Number.isSafeInteger(timeoutValue) ||
      timeoutValue < 1 || timeoutValue > MAX_EMIT_TIMEOUT_MS) {
    fail("emit_timeout");
  }
  const timeoutMs = timeoutValue;
  const span = defineTraceSpanRecord(spanValue);
  if (!isSampled(span.traceId, sampleRate)) return "sampled_out";
  if (signal?.aborted === true) return "aborted";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;
  try {
    const emitted = Promise.resolve().then(() => emit(span)).then(
      () => "emitted" as const,
      () => "bridge_failed" as const,
    );
    const timeout = new Promise<"timed_out">((resolve) => {
      timer = setTimeout(() => resolve("timed_out"), timeoutMs);
    });
    const aborted = signal === undefined
      ? new Promise<never>(() => undefined)
      : new Promise<"aborted">((resolve) => {
          abortHandler = () => resolve("aborted");
          signal.addEventListener("abort", abortHandler, { once: true });
        });
    return await Promise.race([emitted, timeout, aborted]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abortHandler !== undefined) signal?.removeEventListener("abort", abortHandler);
  }
}

/** Bounded best-effort flush; failures remain diagnostics, never evidence upgrades. */
export async function flushTraceBridge(
  bridge: TraceBridge,
  options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
): Promise<TraceFlushResult> {
  const flush = requireBridgeMethod(bridge, "flush", true) as TraceBridge["flush"];
  const normalizedOptions = snapshotRecord(
    options,
    ["signal", "timeoutMs"],
    [],
    "flush_options",
  );
  if (normalizedOptions.signal !== undefined &&
      !(normalizedOptions.signal instanceof AbortSignal)) fail("signal");
  const signal = normalizedOptions.signal as AbortSignal | undefined;
  const timeoutValue = normalizedOptions.timeoutMs ?? 250;
  if (typeof timeoutValue !== "number" || !Number.isSafeInteger(timeoutValue) ||
      timeoutValue < 1 || timeoutValue > MAX_FLUSH_TIMEOUT_MS) {
    fail("flush_timeout");
  }
  const timeoutMs = timeoutValue;
  if (flush === undefined) return "unsupported";
  if (signal?.aborted === true) return "aborted";

  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;
  try {
    const flushResult = Promise.resolve().then(() => flush(signal)).then(
      () => "flushed" as const,
      () => "failed" as const,
    );
    const timeout = new Promise<"timed_out">((resolve) => {
      timer = setTimeout(() => resolve("timed_out"), timeoutMs);
    });
    const abort = signal === undefined
      ? new Promise<never>(() => undefined)
      : new Promise<"aborted">((resolve) => {
          abortHandler = () => resolve("aborted");
          signal.addEventListener("abort", abortHandler, { once: true });
        });
    return await Promise.race([flushResult, timeout, abort]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abortHandler !== undefined) signal?.removeEventListener("abort", abortHandler);
  }
}

function normalizeEvent(value: unknown, start: string, end: string): TraceEventRecord {
  const event = snapshotRecord(value, EVENT_KEYS, ["name", "atUnixNano"], "event");
  if (typeof event.name !== "string" || !EVENT_NAMES.has(event.name)) fail("event_name");
  const at = normalizeUnixNano(event.atUnixNano, "event_time");
  if (BigInt(at) < BigInt(start) || BigInt(at) > BigInt(end)) fail("event_time_order");
  const attributes = event.attributes === undefined
    ? undefined
    : normalizeAttributes(event.attributes);
  return Object.freeze({
    name: event.name as TraceEventName,
    atUnixNano: at,
    ...(attributes === undefined ? {} : { attributes }),
  });
}

function normalizeAttributes(value: unknown): Readonly<Partial<Record<TraceAttributeName, TraceAttributeValue>>> {
  const attributes = snapshotDataDictionary(value, MAX_ATTRIBUTES, () => fail("attributes"));
  const keys = Object.keys(attributes);
  if (keys.some((key) => !ATTRIBUTE_NAMES.has(key))) {
    fail("attributes");
  }
  const normalized: Partial<Record<TraceAttributeName, TraceAttributeValue>> = {};
  for (const key of keys as TraceAttributeName[]) {
    normalized[key] = normalizeAttributeValue(key, attributes[key]);
  }
  return Object.freeze(normalized);
}

function normalizeAttributeValue(key: TraceAttributeName, value: unknown): TraceAttributeValue {
  if (NUMBER_ATTRIBUTES.has(key)) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      fail("attribute_value");
    }
    return value;
  }
  if (BOOLEAN_ATTRIBUTES.has(key)) {
    if (typeof value !== "boolean") fail("attribute_value");
    return value;
  }
  if (ARRAY_ATTRIBUTES.has(key)) {
    const items = snapshotDenseArray(value, MAX_ATTRIBUTE_ARRAY, () => fail("attribute_value"));
    if (items.some((item) => typeof item !== "string" || item.length === 0 ||
          item.length > MAX_ATTRIBUTE_STRING || /[\0\r\n]/u.test(item))) {
      fail("attribute_value");
    }
    return Object.freeze([...items]) as readonly string[];
  }
  if (typeof value !== "string" || value.length === 0 ||
      value.length > MAX_ATTRIBUTE_STRING || /[\0\r\n]/u.test(value)) {
    fail("attribute_value");
  }
  return value;
}

function isSampled(traceId: string, sampleRate: number): boolean {
  if (sampleRate <= 0) return false;
  if (sampleRate >= 1) return true;
  const bucket = Number.parseInt(traceId.slice(0, 8), 16) / 0x1_0000_0000;
  return bucket < sampleRate;
}

function requireBridgeMethod(
  bridge: unknown,
  method: "emit" | "flush",
  optional = false,
): Function | undefined {
  if (bridge === null || (typeof bridge !== "object" && typeof bridge !== "function")) {
    fail("bridge");
  }
  let candidate: unknown;
  try {
    candidate = Reflect.get(bridge, method);
  } catch {
    fail("bridge");
  }
  if (candidate === undefined && optional) return undefined;
  if (typeof candidate !== "function") fail("bridge");
  return (...args: unknown[]) => Reflect.apply(candidate, bridge, args);
}

function normalizeUnixNano(value: unknown, field: string): string {
  if (typeof value !== "string" || !UNIX_NANO.test(value)) fail(field);
  return value;
}

function snapshotRecord(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
  field: string,
): Readonly<Record<string, unknown>> {
  return snapshotDataRecord(value, allowed, required, () => fail(field));
}

function requireOneOf(value: unknown, values: readonly string[], field: string): void {
  if (typeof value !== "string" || !values.includes(value)) fail(field);
}

function fail(field: string): never {
  throw new Error(`cave_trace_invalid:${field}`);
}
