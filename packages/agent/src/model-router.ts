import type {
  ModelCallRouteDecision,
  ModelCallRouteInput,
  ModelCallRouter,
} from "./runtime.js";
import {
  snapshotDataDictionary,
  snapshotDataRecord,
  snapshotDenseArray,
} from "./strict-data.js";
import { abortable } from "./async-boundary.js";

export const FINITE_JSON_MAX_BYTES = 64 * 1024;
export const FINITE_JSON_MAX_DEPTH = 16;
export const FINITE_JSON_MAX_ENTRIES = 1_024;
export const MODEL_ROUTER_STATE_MAX_BYTES = FINITE_JSON_MAX_BYTES;
export const MODEL_ROUTER_STATE_MAX_DEPTH = FINITE_JSON_MAX_DEPTH;
export const MODEL_ROUTER_STATE_MAX_ENTRIES = FINITE_JSON_MAX_ENTRIES;
export const MODEL_ROUTER_MAX_SIGNALS = 64;

export type FiniteJSON =
  | null
  | boolean
  | number
  | string
  | readonly FiniteJSON[]
  | { readonly [key: string]: FiniteJSON };

export type ModelRouterJSON = FiniteJSON;

export interface ModelRouterSnapshot {
  readonly schemaVersion: 1;
  readonly routerId: string;
  readonly revision: number;
  readonly state: ModelRouterJSON;
}

export interface ModelRouterContext {
  readonly input: ModelCallRouteInput;
  readonly state: ModelRouterJSON;
  readonly revision: number;
  readonly signal: AbortSignal;
}

export interface ModelRouterTransition {
  readonly decision: ModelCallRouteDecision;
  readonly state: ModelRouterJSON;
}

export interface ModelRouterDefinition {
  readonly id: string;
  readonly initialState?: ModelRouterJSON;
  readonly route: (
    context: ModelRouterContext,
  ) => ModelRouterTransition | Promise<ModelRouterTransition>;
}

export interface ModelRouter {
  readonly id: string;
  route(input: ModelCallRouteInput, signal?: AbortSignal): Promise<ModelCallRouteDecision>;
  snapshot(): ModelRouterSnapshot;
}

export interface CreateModelRouterOptions {
  readonly snapshot?: ModelRouterSnapshot;
}

const DEFINITION_KEYS = Object.freeze(["id", "initialState", "route"]);
const DEFINITION_REQUIRED_KEYS = Object.freeze(["id", "route"]);
const OPTIONS_KEYS = Object.freeze(["snapshot"]);
const SNAPSHOT_KEYS = Object.freeze(["schemaVersion", "routerId", "revision", "state"]);
const INPUT_KEYS = Object.freeze([
  "callIndex",
  "role",
  "provider",
  "currentModel",
  "ctxTokens",
  "hasImages",
  "toolErrorStreak",
  "previousUsage",
]);
const INPUT_REQUIRED_KEYS = Object.freeze([
  "callIndex",
  "role",
  "provider",
  "currentModel",
  "ctxTokens",
  "hasImages",
  "toolErrorStreak",
]);
const PREVIOUS_USAGE_KEYS = Object.freeze([
  "model",
  "inputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
]);
const PREVIOUS_USAGE_REQUIRED_KEYS = Object.freeze([
  "model",
  "cacheReadTokens",
  "cacheWriteTokens",
]);
const TRANSITION_KEYS = Object.freeze(["decision", "state"]);
const DECISION_KEYS = Object.freeze(["model", "reason", "signals"]);
const ROUTER_KEYS = Object.freeze(["id", "route", "snapshot"]);
const ROUTER_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,63})$/;
const PROVIDER_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,127})$/;
const NEVER_ABORTS = new AbortController().signal;

export function createModelRouter(
  definition: ModelRouterDefinition,
  options: CreateModelRouterOptions = {},
): ModelRouter {
  return createRouter(definition, options, true);
}

/**
 * Wraps existing `ModelCallRouter` code in a state-free router. Its snapshot is
 * always revision zero with null state; adaptation cannot invent durability.
 */
export function adaptStatelessModelCallRouter(
  id: string,
  router: ModelCallRouter,
): ModelRouter {
  if (typeof router !== "function") throw new Error("cave_model_router_compat_invalid");
  return createRouter({
    id,
    initialState: null,
    async route(context) {
      return Object.freeze({
        decision: await router(context.input),
        state: null,
      });
    },
  }, {}, false);
}

/** Adapts routing only; existing runtime remains sole owner of provider I/O. */
export function asModelCallRouter(router: ModelRouter): ModelCallRouter {
  const snapshot = snapshotDataRecord(
    router,
    ROUTER_KEYS,
    ROUTER_KEYS,
    () => { throw new Error("cave_model_router_compat_invalid"); },
  );
  if (typeof snapshot["id"] !== "string" || !ROUTER_ID.test(snapshot["id"]) ||
      typeof snapshot["route"] !== "function" || typeof snapshot["snapshot"] !== "function") {
    throw new Error("cave_model_router_compat_invalid");
  }
  const route = snapshot["route"] as ModelRouter["route"];
  return Object.freeze(async (input: ModelCallRouteInput) => route.call(router, input, NEVER_ABORTS));
}

function createRouter(
  definition: ModelRouterDefinition,
  options: CreateModelRouterOptions,
  stateful: boolean,
): ModelRouter {
  const defined = snapshotDataRecord(
    definition,
    DEFINITION_KEYS,
    DEFINITION_REQUIRED_KEYS,
    () => { throw new Error("cave_model_router_definition_invalid"); },
  );
  if (typeof defined["id"] !== "string" || !ROUTER_ID.test(defined["id"]) ||
      typeof defined["route"] !== "function") {
    throw new Error("cave_model_router_definition_invalid");
  }
  const normalizedOptions = snapshotDataRecord(
    options,
    OPTIONS_KEYS,
    [],
    () => { throw new Error("cave_model_router_options_invalid"); },
  );

  const id = defined["id"];
  const route = defined["route"] as ModelRouterDefinition["route"];
  let revision = 0;
  let state = normalizeFiniteJSON(
    Object.hasOwn(defined, "initialState") ? defined["initialState"] : null,
  );
  const suppliedSnapshot = Object.hasOwn(normalizedOptions, "snapshot")
    ? normalizedOptions["snapshot"]
    : undefined;
  if (Object.hasOwn(normalizedOptions, "snapshot") && suppliedSnapshot === undefined) {
    throw new Error("cave_model_router_options_invalid");
  }
  if (suppliedSnapshot !== undefined) {
    if (!stateful) throw new Error("cave_model_router_stateless_snapshot_refused");
    const snapshot = normalizeSnapshot(suppliedSnapshot, id);
    revision = snapshot.revision;
    state = snapshot.state;
  }
  let busy = false;

  const modelRouter: ModelRouter = {
    id,
    async route(input: ModelCallRouteInput, signal: AbortSignal = NEVER_ABORTS) {
      if (busy) throw new Error("cave_model_router_in_use");
      if (stateful && revision === Number.MAX_SAFE_INTEGER) {
        throw new Error("cave_model_router_revision_exhausted");
      }
      const normalizedInput = normalizeRouteInput(input);
      if (!(signal instanceof AbortSignal)) throw new Error("cave_model_router_signal_invalid");
      throwIfAborted(signal);
      busy = true;
      let rawRoute: Promise<ModelRouterTransition> | undefined;
      try {
        const context = Object.freeze({ input: normalizedInput, state, revision, signal });
        rawRoute = Promise.resolve().then(() => route(context));
        const transition = await abortable(rawRoute, signal, () => abortReason(signal));
        throwIfAborted(signal);
        const normalizedTransition = snapshotDataRecord(
          transition,
          TRANSITION_KEYS,
          TRANSITION_KEYS,
          () => { throw new Error("cave_model_router_transition_invalid"); },
        );
        const decision = normalizeDecision(
          normalizedTransition["decision"],
          normalizedInput.provider,
        );
        const nextState = normalizeFiniteJSON(normalizedTransition["state"]);
        throwIfAborted(signal);
        if (stateful) {
          state = nextState;
          revision++;
        } else if (nextState !== null) {
          throw new Error("cave_model_router_stateless_state_refused");
        }
        return decision;
      } finally {
        if (rawRoute !== undefined && signal.aborted) {
          void rawRoute.then(
            () => { busy = false; },
            () => { busy = false; },
          );
        } else {
          busy = false;
        }
      }
    },
    snapshot() {
      return Object.freeze({
        schemaVersion: 1 as const,
        routerId: id,
        revision,
        state: normalizeFiniteJSON(state),
      });
    },
  };
  return Object.freeze(modelRouter);
}

function normalizeSnapshot(value: unknown, routerId: string): ModelRouterSnapshot {
  const snapshot = snapshotDataRecord(
    value,
    SNAPSHOT_KEYS,
    SNAPSHOT_KEYS,
    () => { throw new Error("cave_model_router_snapshot_invalid"); },
  );
  if (snapshot["schemaVersion"] !== 1 || snapshot["routerId"] !== routerId ||
      !isNonNegativeSafeInteger(snapshot["revision"])) {
    throw new Error("cave_model_router_snapshot_invalid");
  }
  return Object.freeze({
    schemaVersion: 1,
    routerId,
    revision: snapshot["revision"],
    state: normalizeFiniteJSON(snapshot["state"]),
  });
}

function normalizeRouteInput(value: unknown): ModelCallRouteInput {
  const snapshot = snapshotDataRecord(
    value,
    INPUT_KEYS,
    INPUT_REQUIRED_KEYS,
    () => { throw new Error("cave_model_router_input_invalid"); },
  );
  if (!isNonNegativeSafeInteger(snapshot["callIndex"]) ||
      (snapshot["role"] !== "working" && snapshot["role"] !== "compaction") ||
      typeof snapshot["provider"] !== "string" || !PROVIDER_ID.test(snapshot["provider"]) ||
      !isBoundedText(snapshot["currentModel"], 512) ||
      !hasProviderModel(snapshot["currentModel"], snapshot["provider"]) ||
      !isNonNegativeSafeInteger(snapshot["ctxTokens"]) ||
      typeof snapshot["hasImages"] !== "boolean" ||
      !isNonNegativeSafeInteger(snapshot["toolErrorStreak"])) {
    throw new Error("cave_model_router_input_invalid");
  }
  if (Object.hasOwn(snapshot, "previousUsage") && snapshot["previousUsage"] === undefined) {
    throw new Error("cave_model_router_previous_usage_invalid");
  }

  const normalized: {
    callIndex: number;
    role: "working" | "compaction";
    provider: string;
    currentModel: string;
    ctxTokens: number;
    hasImages: boolean;
    toolErrorStreak: number;
    previousUsage?: NonNullable<ModelCallRouteInput["previousUsage"]>;
  } = {
    callIndex: snapshot["callIndex"],
    role: snapshot["role"],
    provider: snapshot["provider"],
    currentModel: snapshot["currentModel"],
    ctxTokens: snapshot["ctxTokens"],
    hasImages: snapshot["hasImages"],
    toolErrorStreak: snapshot["toolErrorStreak"],
  };
  if (Object.hasOwn(snapshot, "previousUsage")) {
    const usage = snapshotDataRecord(
      snapshot["previousUsage"],
      PREVIOUS_USAGE_KEYS,
      PREVIOUS_USAGE_REQUIRED_KEYS,
      () => { throw new Error("cave_model_router_previous_usage_invalid"); },
    );
    if (!isBoundedText(usage["model"], 512) ||
        (Object.hasOwn(usage, "inputTokens") && usage["inputTokens"] === undefined) ||
        (usage["inputTokens"] !== undefined && !isNonNegativeSafeInteger(usage["inputTokens"])) ||
        !isNonNegativeSafeInteger(usage["cacheReadTokens"]) ||
        !isNonNegativeSafeInteger(usage["cacheWriteTokens"])) {
      throw new Error("cave_model_router_previous_usage_invalid");
    }
    const normalizedUsage: {
      model: string;
      inputTokens?: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
    } = {
      model: usage["model"],
      cacheReadTokens: usage["cacheReadTokens"],
      cacheWriteTokens: usage["cacheWriteTokens"],
    };
    if (Object.hasOwn(usage, "inputTokens")) {
      normalizedUsage.inputTokens = usage["inputTokens"] as number;
    }
    normalized.previousUsage = Object.freeze(normalizedUsage);
  }
  const result: {
    callIndex: number;
    role: "working" | "compaction";
    provider: string;
    currentModel: string;
    ctxTokens: number;
    hasImages: boolean;
    toolErrorStreak: number;
    previousUsage?: NonNullable<ModelCallRouteInput["previousUsage"]>;
  } = {
    callIndex: normalized.callIndex,
    role: normalized.role,
    provider: normalized.provider,
    currentModel: normalized.currentModel,
    ctxTokens: normalized.ctxTokens,
    hasImages: normalized.hasImages,
    toolErrorStreak: normalized.toolErrorStreak,
  };
  // Absent stays absent: a non-enumerable `undefined` placeholder is rejected
  // by this module's own `snapshotDataRecord` contract, so a router that
  // forwards `context.input` to another router would fail closed on valid data.
  if (normalized.previousUsage !== undefined) {
    result.previousUsage = normalized.previousUsage;
  }
  return Object.freeze(result);
}

function normalizeDecision(value: unknown, provider: string): ModelCallRouteDecision {
  const snapshot = snapshotDataRecord(
    value,
    DECISION_KEYS,
    DECISION_KEYS,
    () => { throw new Error("cave_model_router_decision_invalid"); },
  );
  if (!isBoundedText(snapshot["model"], 512) ||
      !hasProviderModel(snapshot["model"], provider) ||
      !isBoundedText(snapshot["reason"], 1_024)) {
    throw new Error("cave_model_router_decision_invalid");
  }
  const signalValues = snapshotDenseArray(
    snapshot["signals"],
    MODEL_ROUTER_MAX_SIGNALS,
    () => { throw new Error("cave_model_router_decision_invalid"); },
  );
  const signals: string[] = [];
  const seen = new Set<string>();
  for (const signal of signalValues) {
    if (!isBoundedText(signal, 256) || seen.has(signal)) {
      throw new Error("cave_model_router_decision_invalid");
    }
    seen.add(signal);
    signals.push(signal);
  }
  return Object.freeze({
    model: snapshot["model"],
    reason: snapshot["reason"],
    signals: Object.freeze(signals),
  });
}

/** Copies, deep-freezes, and bounds one JSON value for state or opaque input. */
export function normalizeFiniteJSON(value: unknown): FiniteJSON {
  const tracker = { entries: 0, rawCharacters: 0 };
  const active = new Set<object>();
  const copy = copyJSONValue(value, 0, tracker, active);
  if (Buffer.byteLength(serializeFiniteJSON(copy), "utf8") > MODEL_ROUTER_STATE_MAX_BYTES) {
    throw new Error("cave_finite_json_bytes_limit");
  }
  return copy;
}

function serializeFiniteJSON(value: FiniteJSON): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (let index = 0; index < value.length; index++) {
      items.push(serializeFiniteJSON(value[index]!));
    }
    return `[${items.join(",")}]`;
  }
  const fields: string[] = [];
  const record = value as Readonly<Record<string, FiniteJSON>>;
  for (const key of Object.keys(record)) {
    fields.push(`${JSON.stringify(key)}:${serializeFiniteJSON(record[key]!)}`);
  }
  return `{${fields.join(",")}}`;
}

function copyJSONValue(
  value: unknown,
  depth: number,
  tracker: { entries: number; rawCharacters: number },
  active: Set<object>,
): FiniteJSON {
  if (depth > MODEL_ROUTER_STATE_MAX_DEPTH) {
    throw new Error("cave_finite_json_depth_limit");
  }
  tracker.entries++;
  if (tracker.entries > MODEL_ROUTER_STATE_MAX_ENTRIES) {
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
        MODEL_ROUTER_STATE_MAX_ENTRIES,
        () => { throw new Error("cave_finite_json_non_json"); },
      );
      if (tracker.entries + items.length > MODEL_ROUTER_STATE_MAX_ENTRIES) {
        throw new Error("cave_finite_json_entries_limit");
      }
      const copy: FiniteJSON[] = [];
      for (const item of items) {
        copy.push(copyJSONValue(item, depth + 1, tracker, active));
      }
      return Object.freeze(copy);
    }
    const record = snapshotDataDictionary(
      value,
      MODEL_ROUTER_STATE_MAX_ENTRIES,
      () => { throw new Error("cave_finite_json_non_json"); },
    );
    const own = Object.keys(record);
    const copy: Record<string, FiniteJSON> = {};
    for (const key of own) {
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

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("cave_model_router_aborted");
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isBoundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim() !== "" && value.length <= maxLength;
}

function hasProviderModel(model: string, provider: string): boolean {
  return model.startsWith(`${provider}/`) && model.length > provider.length + 1;
}

function addRawCharacters(
  tracker: { entries: number; rawCharacters: number },
  count: number,
): void {
  tracker.rawCharacters += count;
  if (tracker.rawCharacters > MODEL_ROUTER_STATE_MAX_BYTES) {
    throw new Error("cave_finite_json_bytes_limit");
  }
}
