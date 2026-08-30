import {
  defineAdapterLifecycleEvent,
  defineAdapterLifecycleIdentity,
  defineAdapterPackage,
} from "@caveman-ai/adapter-kit";
import { genericObservability } from "agents/observability";
import { adapterManifest } from "./manifest.js";

const OPTION_KEYS = Object.freeze([
  "observability",
  "onLifecycleEvent",
  "onObserverError",
]);
const MAX_ACTIVE_RUNS = 1_024;
const MAX_PENDING_OBSERVATIONS = 64;
const MAX_NATIVE_RUN_ID_LENGTH = 230;
const NATIVE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const CHAT_SUCCESS_STATUSES = new Set(["completed", "skipped"]);
const CHAT_ERROR_STATUSES = new Set(["error", "aborted"]);
const NO_DATA = Symbol("no-data");

export const CLOUDFLARE_AGENTS_VERSION = "0.22.0";

/**
 * Compose Caveman lifecycle observation with Cloudflare's native Observability
 * seam. Cloudflare retains ownership of Durable Objects, workflows, retries,
 * alarms, routing, tools, model calls, and streams.
 */
export function createCloudflareAgentsAdapter(options = {}) {
  const normalized = normalizeOptions(options);
  const nativeObserver = captureNativeObserver(
    normalized.observability ?? genericObservability,
  );
  const observer = createLifecycleObserver(normalized);

  const observability = Object.freeze({
    emit(...args) {
      let result;
      let nativeError;
      let nativeThrew = false;
      try {
        if (nativeObserver !== undefined) {
          result = Reflect.apply(nativeObserver.method, nativeObserver.receiver, args);
        }
      } catch (error) {
        nativeThrew = true;
        nativeError = error;
      }

      // Translation is diagnostic-only. It cannot replace native result/error.
      try {
        observer.observe(args.length === 1 ? args[0] : undefined);
      } catch {
        // Includes hostile event proxies and hostile thenable accessors.
      }
      if (nativeThrew) throw nativeError;
      return result;
    },
  });

  return Object.freeze({ observability });
}

function createLifecycleObserver(options) {
  const activeRuns = new Map();
  const pending = new Set();
  let nextSequence = 0;

  const report = (stage, eventType, error) => {
    if (options.onObserverError === undefined) return;
    dispatchDetached(
      options.onObserverError,
      Object.freeze({ stage, eventType, error }),
      pending,
      undefined,
    );
  };

  const emit = (phase, identity, nativeType) => {
    if (options.onLifecycleEvent === undefined) return;
    if (nextSequence >= Number.MAX_SAFE_INTEGER) {
      report("sequence", nativeType, new Error("cave_cloudflare_adapter_sequence_exhausted"));
      return;
    }
    let event;
    try {
      event = defineAdapterLifecycleEvent({
        schemaVersion: 1,
        seq: nextSequence,
        phase,
        identity,
      });
      nextSequence += 1;
    } catch (error) {
      report("translate", nativeType, error);
      return;
    }
    dispatchDetached(options.onLifecycleEvent, event, pending, (error) => {
      report("lifecycle_sink", nativeType, error);
    });
  };

  const startRun = (kind, nativeType, nativeId, nativeKey) => {
    const key = runKey(kind, nativeId);
    const runId = canonicalRunId(kind, nativeId);
    if (key === undefined || runId === undefined) {
      report("identity", nativeType, new Error("cave_cloudflare_adapter_identity_invalid"));
      return;
    }
    if (activeRuns.has(key)) {
      report("sequence", nativeType, new Error("cave_cloudflare_adapter_duplicate_start"));
      return;
    }
    if (activeRuns.size >= MAX_ACTIVE_RUNS) {
      report("capacity", nativeType, new Error("cave_cloudflare_adapter_run_capacity"));
      return;
    }
    let identity;
    try {
      identity = defineAdapterLifecycleIdentity({
        runId,
        attempt: 1,
        replay: false,
        nativeIds: { [nativeKey]: nativeId },
      });
    } catch (error) {
      report("identity", nativeType, error);
      return;
    }
    activeRuns.set(key, identity);
    emit("run.started", identity, nativeType);
  };

  const finishRun = (kind, nativeType, nativeId, phase) => {
    const key = runKey(kind, nativeId);
    if (key === undefined) {
      report("identity", nativeType, new Error("cave_cloudflare_adapter_identity_invalid"));
      return;
    }
    const identity = activeRuns.get(key);
    if (identity === undefined) {
      report("sequence", nativeType, new Error("cave_cloudflare_adapter_finish_without_start"));
      return;
    }
    activeRuns.delete(key);
    emit(phase, identity, nativeType);
  };

  return Object.freeze({
    observe(value) {
      if (options.onLifecycleEvent === undefined) return;
      const type = ownDataValue(value, "type");
      if (typeof type !== "string" || !isMappedEvent(type)) return;
      const payload = ownDataValue(value, "payload");
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        report("event", type, new Error("cave_cloudflare_adapter_payload_invalid"));
        return;
      }

      switch (type) {
        case "chat:turn:start":
          startRun("chat", type, ownDataValue(payload, "requestId"), "cloudflareRequestId");
          break;
        case "chat:turn:finish": {
          const requestId = ownDataValue(payload, "requestId");
          const status = ownDataValue(payload, "status");
          if (CHAT_SUCCESS_STATUSES.has(status)) {
            finishRun("chat", type, requestId, "run.completed");
          } else if (CHAT_ERROR_STATUSES.has(status)) {
            finishRun("chat", type, requestId, "run.error");
          } else {
            report("status", type, new Error("cave_cloudflare_adapter_status_unknown"));
            discardRun("chat", requestId);
          }
          break;
        }
        case "fiber:run:started":
          startRun("fiber", type, ownDataValue(payload, "fiberId"), "cloudflareFiberId");
          break;
        case "fiber:run:completed":
          finishRun("fiber", type, ownDataValue(payload, "fiberId"), "run.completed");
          break;
        case "fiber:run:failed":
        case "fiber:run:interrupted":
          finishRun("fiber", type, ownDataValue(payload, "fiberId"), "run.error");
          break;
        default:
          // Unmapped native events stay host-owned.
          break;
      }
    },
  });

  function discardRun(kind, nativeId) {
    const key = runKey(kind, nativeId);
    if (key !== undefined) activeRuns.delete(key);
  }
}

function normalizeOptions(value) {
  const record = ownDataRecord(value);
  if (record === undefined || Object.keys(record).some((key) => !OPTION_KEYS.includes(key))) {
    throw new Error("cave_cloudflare_adapter_options_invalid");
  }
  for (const key of ["onLifecycleEvent", "onObserverError"]) {
    if (record[key] !== undefined && typeof record[key] !== "function") {
      throw new Error(`cave_cloudflare_adapter_option_invalid:${key}`);
    }
  }
  return record;
}

function captureNativeObserver(value) {
  if (value === undefined) return undefined;
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    throw new Error("cave_cloudflare_adapter_observability_invalid");
  }
  const method = Reflect.get(value, "emit", value);
  if (typeof method !== "function") {
    throw new Error("cave_cloudflare_adapter_observability_invalid");
  }
  return Object.freeze({ receiver: value, method });
}

function dispatchDetached(sink, value, pending, onError) {
  if (pending.size >= MAX_PENDING_OBSERVATIONS) {
    if (onError !== undefined) {
      onError(new Error("cave_cloudflare_adapter_observer_capacity"));
    }
    return;
  }
  let result;
  try {
    result = Reflect.apply(sink, undefined, [value]);
  } catch (error) {
    if (onError !== undefined) onError(error);
    return;
  }
  let then;
  try {
    then = captureThen(result);
  } catch (error) {
    if (onError !== undefined) onError(error);
    return;
  }
  if (then === undefined) return;

  // Capture `then` once. Native sink thenables run from Promise assimilation,
  // outside Cloudflare's emit stack.
  const task = Promise.resolve({
    then(resolve, reject) {
      return Reflect.apply(then, result, [resolve, reject]);
    },
  });
  pending.add(task);
  task.then(
    () => pending.delete(task),
    (error) => {
      pending.delete(task);
      if (onError !== undefined) onError(error);
    },
  );
}

function ownDataRecord(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const record = Object.create(null);
  for (const key of Object.keys(descriptors)) {
    const descriptor = descriptors[key];
    if (!("value" in descriptor)) return undefined;
    record[key] = descriptor.value;
  }
  return record;
}

function ownDataValue(value, key) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return NO_DATA;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : NO_DATA;
}

function captureThen(value) {
  if (!((typeof value === "object" && value !== null) || typeof value === "function")) {
    return undefined;
  }
  const then = Reflect.get(value, "then", value);
  return typeof then === "function" ? then : undefined;
}

function canonicalRunId(kind, value) {
  if (!isNativeRunId(value)) return undefined;
  return `cloudflare:${kind}:${value}`;
}

function runKey(kind, value) {
  if (!isNativeRunId(value)) return undefined;
  return `${kind}\0${value}`;
}

function isNativeRunId(value) {
  return typeof value === "string" && value.length > 0 &&
    value.length <= MAX_NATIVE_RUN_ID_LENGTH && NATIVE_RUN_ID.test(value);
}

function isMappedEvent(type) {
  return type === "chat:turn:start" || type === "chat:turn:finish" ||
    type === "fiber:run:started" || type === "fiber:run:completed" ||
    type === "fiber:run:failed" || type === "fiber:run:interrupted";
}

export const manifest = adapterManifest;
export const createAdapter = createCloudflareAgentsAdapter;

const adapterPackage = defineAdapterPackage({
  manifest: adapterManifest,
  createAdapter: createCloudflareAgentsAdapter,
});

export default adapterPackage;
