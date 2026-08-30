import { createHash, randomUUID } from "node:crypto";
import {
  defineAdapterLifecycleEvent,
  defineAdapterLifecycleIdentity,
  defineAdapterPackage,
} from "@caveman-ai/adapter-kit";
import { defineModelUsage } from "@caveman-ai/agent/model-usage";
import { adapterManifest } from "./manifest.js";

const PROCESSOR_ID = "caveman-agent-sdk";
const MAX_TOOL_EVENTS = 2_048;
const MAX_NATIVE_VALUE_LENGTH = 1_024;
const OPTION_KEYS = Object.freeze([
  "model",
  "modelBoundary",
  "onLifecycle",
  "onModelUsage",
  "onObserverError",
]);
const MODEL_KEYS = Object.freeze(["provider", "model"]);
const NORMALIZED_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const PROVIDER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const NEVER_ABORT_SIGNAL = new AbortController().signal;

/**
 * Create one native Mastra Processor. Add the same object to inputProcessors
 * and outputProcessors; it never calls a provider or replaces Mastra's loop.
 */
export function createMastraAdapter(options = {}) {
  const normalized = normalizeOptions(options);
  const runs = new WeakMap();

  const processor = {
    id: PROCESSOR_ID,
    name: "Caveman Agent SDK",
    // Mastra assigns this native bookkeeping field while composing processors.
    processorIndex: undefined,

    async processLLMRequest(args) {
      const run = runFor(runs, args, normalized.report);
      if (run === undefined) return { prompt: readNative(args, "prompt") };

      const prompt = readNative(args, "prompt");
      const stepNumber = readNonNegativeInteger(args, "stepNumber");
      const retryCount = readNonNegativeInteger(args, "retryCount");
      run.activeStep = stepNumber;

      let model;
      try {
        model = normalized.model ?? modelIdentity(readNative(args, "model"));
      } catch (error) {
        if (normalized.boundary !== undefined) throw error;
        normalized.report("model.identity", error);
        return { prompt };
      }

      const callOrdinal = ++run.modelOrdinal;
      const identity = modelCallIdentity(run, stepNumber, retryCount, callOrdinal, model);
      let prepared;
      let transformed = prompt;
      if (normalized.boundary !== undefined) {
        const signal = readOptionalNative(args, "abortSignal") ?? NEVER_ABORT_SIGNAL;
        if (!(signal instanceof AbortSignal)) {
          throw new Error("cave_mastra_adapter_abort_signal_invalid");
        }
        prepared = captureBoundaryCall(await Reflect.apply(
          normalized.boundary.prepare,
          normalized.boundary.target,
          [prompt, Object.freeze({
            identity,
            role: "working",
            provider: model.provider,
            model: model.model,
            signal,
          })],
        ));
        transformed = prepared.request;
      }

      run.pending.set(stepNumber, Object.freeze({
        identity,
        model,
        prepared,
        retryCount,
      }));
      run.skippedUsage.delete(stepNumber);
      return { prompt: transformed };
    },

    processLLMResponse(args) {
      const run = existingRun(runs, args, normalized.report);
      if (run === undefined) return;
      const stepNumber = readNonNegativeInteger(args, "stepNumber");
      const call = run.pending.get(stepNumber);
      run.pending.delete(stepNumber);

      const fromCache = readNative(args, "fromCache");
      if (fromCache !== true && fromCache !== false) {
        normalized.report(
          "model.response",
          new Error("cave_mastra_adapter_cache_state_invalid"),
        );
        discardBufferedTools(run, stepNumber);
        run.skippedUsage.add(stepNumber);
        return;
      }
      if (fromCache) {
        // Replay ownership stays with Mastra. No provider outcome is claimed.
        discardBufferedTools(run, stepNumber);
        run.skippedUsage.add(stepNumber);
        return;
      }
      if (call === undefined) {
        normalized.report(
          "model.response",
          new Error("cave_mastra_adapter_model_call_missing"),
        );
        discardBufferedTools(run, stepNumber);
        return;
      }

      run.models.set(stepNumber, call);
      if (normalized.onLifecycle !== undefined) {
        ensureRunStarted(run, normalized);
        emitLifecycle(run, "model.requested", call.identity, normalized);
        emitLifecycle(run, "model.responded", call.identity, normalized);
        flushBufferedTools(run, stepNumber, normalized);
      } else {
        discardBufferedTools(run, stepNumber);
      }

      if (call.prepared !== undefined) {
        const response = Object.freeze({
          chunks: readNative(args, "chunks"),
          warnings: readOptionalNative(args, "warnings"),
          request: readOptionalNative(args, "request"),
          rawResponse: readOptionalNative(args, "rawResponse"),
          fromCache: false,
          model: readNative(args, "model"),
          stepNumber,
        });
        observePromise(
          () => Reflect.apply(
            call.prepared.settled,
            call.prepared.target,
            [response],
          ),
          normalized.report,
          "model.settled",
        );
      }
    },

    async processOutputStream(args) {
      const part = readNative(args, "part");
      if (normalized.onLifecycle === undefined) return part;
      const run = existingRun(runs, args, normalized.report);
      if (run === undefined) return part;

      try {
        observeToolChunk(run, part, normalized);
      } catch (error) {
        normalized.report("tool.chunk", error);
      }
      return part;
    },

    processOutputStep(args) {
      const messageList = readNative(args, "messageList");
      if (normalized.onModelUsage === undefined) return messageList;
      const run = existingRun(runs, args, normalized.report);
      if (run === undefined) return messageList;

      try {
        const stepNumber = readNonNegativeInteger(args, "stepNumber");
        if (run.skippedUsage.has(stepNumber)) return messageList;
        const call = run.models.get(stepNumber);
        if (call === undefined) {
          throw new Error("cave_mastra_adapter_usage_identity_missing");
        }
        const usage = normalizeMastraUsage(readNative(args, "usage"), call.model);
        const observation = Object.freeze({ usage, identity: call.identity });
        observeCallback(
          normalized.onModelUsage,
          observation,
          normalized.report,
          "usage.sink",
        );
      } catch (error) {
        normalized.report("usage.normalize", error);
      }
      return messageList;
    },

    processOutputResult(args) {
      const messageList = readNative(args, "messageList");
      const run = existingRun(runs, args, normalized.report);
      if (run === undefined) return messageList;
      if (run.started && normalized.onLifecycle !== undefined) {
        emitLifecycle(run, "run.completed", run.identity, normalized);
      }
      runs.delete(readNative(args, "state"));
      return messageList;
    },

    processAPIError(args) {
      const run = existingRun(runs, args, normalized.report);
      if (run === undefined) return;
      const stepNumber = readNonNegativeInteger(args, "stepNumber");
      const call = run.pending.get(stepNumber);
      run.pending.delete(stepNumber);
      discardBufferedTools(run, stepNumber);
      run.skippedUsage.add(stepNumber);
      if (call?.prepared !== undefined) {
        const error = readNative(args, "error");
        observeExpectedFailure(
          () => Reflect.apply(
            call.prepared.failed,
            call.prepared.target,
            [error],
          ),
          error,
          normalized.report,
          "model.failed",
        );
      }
    },
  };

  return Object.seal(processor);
}

/** Convert Mastra V3 raw or V2 extended usage without inventing zero counts. */
export function normalizeMastraUsage(usage, identity) {
  if (!isObject(usage)) throw new Error("cave_mastra_adapter_usage_invalid");
  const model = normalizeModelIdentity(identity);
  const raw = optionalData(usage, "raw", "cave_mastra_adapter_usage_invalid");
  const nested = nestedV3Usage(raw);
  const counts = nested === undefined
    ? normalizeV2Usage(usage)
    : normalizeV3Usage(nested.input, nested.output);
  const complete = Object.values(counts).every((value) => value !== null);
  return defineModelUsage({
    schemaVersion: 1,
    provider: model.provider,
    model: model.model,
    ...counts,
    cost: { status: complete ? "unpriced" : "unknown" },
  });
}

function normalizeOptions(options) {
  const record = strictDataRecord(
    options,
    OPTION_KEYS,
    "cave_mastra_adapter_options_invalid",
  );
  const modelValue = record.model;
  const model = modelValue === undefined ? undefined : normalizeModelIdentity(modelValue);
  const onLifecycle = optionalCallback(record.onLifecycle, "onLifecycle");
  const onModelUsage = optionalCallback(record.onModelUsage, "onModelUsage");
  const onObserverError = optionalCallback(record.onObserverError, "onObserverError");
  const boundary = captureBoundary(record.modelBoundary);
  const report = (stage, error) => {
    if (onObserverError === undefined) return;
    observeCallback(
      onObserverError,
      Object.freeze({ stage, error }),
      () => undefined,
      "observer.error",
    );
  };
  return Object.freeze({
    model,
    boundary,
    onLifecycle,
    onModelUsage,
    report,
  });
}

function runFor(runs, args, report) {
  const state = readNative(args, "state");
  if (!isObject(state)) {
    report("state", new Error("cave_mastra_adapter_state_invalid"));
    return undefined;
  }
  let run = runs.get(state);
  if (run !== undefined) return run;

  const nativeRun = nativeRunIdentity(args);
  const runId = nativeRun === undefined
    ? `mastra-${randomUUID()}`
    : normalizedNativeId("mastra", nativeRun);
  const nativeIds = nativeRun === undefined
    ? { mastraAdapterRunId: runId }
    : { mastraTraceId: nativeRun };
  let identity;
  try {
    identity = defineAdapterLifecycleIdentity({
      runId,
      attempt: 1,
      replay: false,
      nativeIds,
    });
  } catch (error) {
    report("run.identity", error);
    return undefined;
  }
  run = {
    identity,
    nativeIds,
    seq: 0,
    started: false,
    modelOrdinal: 0,
    activeStep: undefined,
    pending: new Map(),
    models: new Map(),
    tools: new Map(),
    bufferedTools: new Map(),
    bufferedToolCount: 0,
    skippedUsage: new Set(),
    toolObservationDisabled: false,
  };
  runs.set(state, run);
  return run;
}

function existingRun(runs, args, report) {
  const state = readNative(args, "state");
  if (!isObject(state)) {
    report("state", new Error("cave_mastra_adapter_state_invalid"));
    return undefined;
  }
  return runs.get(state);
}

function modelCallIdentity(run, stepNumber, retryCount, ordinal, model) {
  return defineAdapterLifecycleIdentity({
    runId: run.identity.runId,
    stepId: `mastra-step-${stepNumber}`,
    modelCallId: `mastra-model-${stepNumber}-${ordinal}`,
    attempt: 1,
    replay: false,
    nativeIds: {
      ...run.nativeIds,
      mastraModelId: model.model,
      mastraProviderId: model.provider,
      mastraRetryCount: String(retryCount),
      mastraStepNumber: String(stepNumber),
    },
  });
}

function ensureRunStarted(run, normalized) {
  if (run.started) return;
  run.started = true;
  emitLifecycle(run, "run.started", run.identity, normalized);
}

function emitLifecycle(run, phase, identity, normalized) {
  let event;
  try {
    event = defineAdapterLifecycleEvent({
      schemaVersion: 1,
      seq: run.seq,
      phase,
      identity,
    });
  } catch (error) {
    normalized.report("lifecycle.event", error);
    return;
  }
  run.seq += 1;
  observeCallback(
    normalized.onLifecycle,
    event,
    normalized.report,
    "lifecycle.sink",
  );
}

function observeToolChunk(run, part, normalized) {
  if (!isObject(part) || run.toolObservationDisabled) return;
  const type = data(part, "type", "cave_mastra_adapter_chunk_invalid");
  if (type !== "tool-call" && type !== "tool-result" && type !== "tool-error") return;
  const payload = data(part, "payload", "cave_mastra_adapter_chunk_invalid");
  if (!isObject(payload)) throw new Error("cave_mastra_adapter_tool_chunk_invalid");
  const rawToolCallId = data(
    payload,
    "toolCallId",
    "cave_mastra_adapter_tool_chunk_invalid",
  );
  const toolName = data(
    payload,
    "toolName",
    "cave_mastra_adapter_tool_chunk_invalid",
  );
  if (!isNativeValue(rawToolCallId) || !isNativeValue(toolName)) {
    throw new Error("cave_mastra_adapter_tool_chunk_invalid");
  }
  const stepNumber = run.activeStep;
  if (stepNumber === undefined) {
    throw new Error("cave_mastra_adapter_tool_step_missing");
  }

  const key = `${stepNumber}\0${rawToolCallId}`;
  let tool = run.tools.get(key);
  if (tool === undefined) {
    const identity = defineAdapterLifecycleIdentity({
      runId: run.identity.runId,
      stepId: `mastra-step-${stepNumber}`,
      toolCallId: normalizedNativeId(
        "mastra-tool",
        `${run.identity.runId}:${stepNumber}:${rawToolCallId}`,
      ),
      attempt: 1,
      replay: false,
      nativeIds: {
        ...run.nativeIds,
        mastraStepNumber: String(stepNumber),
        mastraToolCallId: rawToolCallId,
        mastraToolName: toolName,
      },
    });
    tool = { identity, proposed: false, started: false, terminal: false };
    run.tools.set(key, tool);
  }

  if (type === "tool-call") {
    if (tool.proposed || tool.started || tool.terminal) return;
    tool.proposed = true;
    queueToolPhase(run, stepNumber, "tool.proposed", tool.identity, normalized);
    return;
  }
  if (tool.terminal) return;
  const isError = type === "tool-error" ||
    (type === "tool-result" && optionalData(
      payload,
      "isError",
      "cave_mastra_adapter_tool_chunk_invalid",
    ) === true);
  if (isError) {
    // Some native error chunks represent rejection before tool execution.
    if (!tool.proposed) {
      tool.proposed = true;
      queueToolPhase(run, stepNumber, "tool.proposed", tool.identity, normalized);
    }
    tool.terminal = true;
    queueToolPhase(run, stepNumber, "tool.error", tool.identity, normalized);
    return;
  }
  if (!tool.started) {
    tool.started = true;
    queueToolPhase(run, stepNumber, "tool.started", tool.identity, normalized);
  }
  tool.terminal = true;
  queueToolPhase(run, stepNumber, "tool.completed", tool.identity, normalized);
}

function queueToolPhase(run, stepNumber, phase, identity, normalized) {
  if (!run.pending.has(stepNumber)) {
    ensureRunStarted(run, normalized);
    emitLifecycle(run, phase, identity, normalized);
    return;
  }
  if (run.bufferedToolCount >= MAX_TOOL_EVENTS) {
    run.toolObservationDisabled = true;
    run.bufferedTools.clear();
    run.bufferedToolCount = 0;
    normalized.report(
      "tool.capacity",
      new Error("cave_mastra_adapter_tool_capacity_exceeded"),
    );
    return;
  }
  const events = run.bufferedTools.get(stepNumber) ?? [];
  events.push(Object.freeze({ phase, identity }));
  run.bufferedTools.set(stepNumber, events);
  run.bufferedToolCount += 1;
}

function flushBufferedTools(run, stepNumber, normalized) {
  const events = run.bufferedTools.get(stepNumber);
  if (events === undefined) return;
  run.bufferedTools.delete(stepNumber);
  run.bufferedToolCount -= events.length;
  for (const event of events) {
    emitLifecycle(run, event.phase, event.identity, normalized);
  }
}

function discardBufferedTools(run, stepNumber) {
  // Dropping queued phases must also drop the phase flags they were queued
  // from. Otherwise a later terminal chunk for the same tool emits
  // tool.completed/tool.error with no observed proposed/started, which a
  // lifecycle validator rejects as completion_without_start.
  const prefix = `${stepNumber}\0`;
  for (const key of run.tools.keys()) {
    if (key.startsWith(prefix)) run.tools.delete(key);
  }
  const events = run.bufferedTools.get(stepNumber);
  if (events === undefined) return;
  run.bufferedTools.delete(stepNumber);
  run.bufferedToolCount -= events.length;
}

function nativeRunIdentity(args) {
  try {
    const tracing = readOptionalNative(args, "tracingContext") ??
      readOptionalNative(args, "tracing");
    if (!isObject(tracing)) return undefined;
    const span = readOptionalNative(tracing, "currentSpan");
    if (!isObject(span)) return undefined;
    const traceId = readOptionalNative(span, "traceId");
    return isNativeValue(traceId) ? traceId : undefined;
  } catch {
    return undefined;
  }
}

function modelIdentity(model) {
  if (!isObject(model)) throw new Error("cave_mastra_adapter_model_identity_invalid");
  let provider;
  let modelId;
  try {
    provider = Reflect.get(model, "provider", model);
    modelId = Reflect.get(model, "modelId", model);
  } catch {
    throw new Error("cave_mastra_adapter_model_identity_invalid");
  }
  return normalizeModelIdentity({ provider, model: modelId });
}

function normalizeModelIdentity(value) {
  const record = strictDataRecord(
    value,
    MODEL_KEYS,
    "cave_mastra_adapter_model_identity_invalid",
  );
  if (typeof record.provider !== "string" || !PROVIDER.test(record.provider) ||
      typeof record.model !== "string" || record.model.length === 0 ||
      Buffer.byteLength(record.model, "utf8") > MAX_NATIVE_VALUE_LENGTH ||
      /[\0\r\n]/u.test(record.model)) {
    throw new Error("cave_mastra_adapter_model_identity_invalid");
  }
  return Object.freeze({ provider: record.provider, model: record.model });
}

function normalizeV3Usage(input, output) {
  const inputTotal = token(input, "total");
  const inputTokens = token(input, "noCache");
  const cacheReadTokens = token(input, "cacheRead");
  const cacheWriteTokens = token(input, "cacheWrite");
  const outputTokens = token(output, "total");
  const reasoningTokens = token(output, "reasoning");
  if (inputTotal !== null && inputTokens !== null && cacheReadTokens !== null &&
      cacheWriteTokens !== null &&
      inputTotal !== inputTokens + cacheReadTokens + cacheWriteTokens) {
    throw new Error("cave_mastra_adapter_usage_invalid:inputTokens");
  }
  const totalTokens = inputTotal === null || outputTokens === null
    ? null
    : inputTotal + outputTokens;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    totalTokens,
  };
}

function normalizeV2Usage(usage) {
  const inputTotal = token(usage, "inputTokens");
  const outputTokens = token(usage, "outputTokens");
  const cacheReadTokens = token(usage, "cachedInputTokens");
  let cacheWriteTokens = token(usage, "cacheCreationInputTokens");
  if (cacheWriteTokens === null) {
    const fiveMinutes = token(usage, "cacheCreationInputTokens5m");
    const oneHour = token(usage, "cacheCreationInputTokens1h");
    if (fiveMinutes !== null && oneHour !== null) {
      cacheWriteTokens = checkedSum(fiveMinutes, oneHour);
    }
  }
  let inputTokens = null;
  if (inputTotal !== null && cacheReadTokens !== null && cacheWriteTokens !== null) {
    inputTokens = inputTotal - cacheReadTokens - cacheWriteTokens;
    if (inputTokens < 0) {
      throw new Error("cave_mastra_adapter_usage_invalid:inputTokens");
    }
  }
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens: token(usage, "reasoningTokens"),
    totalTokens: token(usage, "totalTokens"),
  };
}

function nestedV3Usage(raw) {
  if (!isObject(raw)) return undefined;
  const input = optionalData(raw, "inputTokens", "cave_mastra_adapter_usage_invalid");
  const output = optionalData(raw, "outputTokens", "cave_mastra_adapter_usage_invalid");
  return isObject(input) && isObject(output) ? { input, output } : undefined;
}

function token(record, key) {
  const value = optionalData(record, key, "cave_mastra_adapter_usage_invalid");
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`cave_mastra_adapter_usage_invalid:${key}`);
  }
  return value;
}

function checkedSum(left, right) {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) {
    throw new Error("cave_mastra_adapter_usage_invalid:cacheCreationInputTokens");
  }
  return sum;
}

function captureBoundary(value) {
  if (value === undefined) return undefined;
  if (!isObject(value)) throw new Error("cave_mastra_adapter_model_boundary_invalid");
  let prepare;
  try {
    prepare = Reflect.get(value, "prepare", value);
  } catch {
    throw new Error("cave_mastra_adapter_model_boundary_invalid");
  }
  if (typeof prepare !== "function") {
    throw new Error("cave_mastra_adapter_model_boundary_invalid");
  }
  return Object.freeze({ target: value, prepare });
}

function captureBoundaryCall(value) {
  if (!isObject(value) || Array.isArray(value)) {
    throw new Error("cave_mastra_adapter_boundary_call_invalid");
  }
  let descriptors;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new Error("cave_mastra_adapter_boundary_call_invalid");
  }
  const request = descriptors.request;
  const settled = descriptors.settled;
  const failed = descriptors.failed;
  if (request === undefined || !("value" in request) ||
      settled === undefined || !("value" in settled) ||
      typeof settled.value !== "function" ||
      failed === undefined || !("value" in failed) ||
      typeof failed.value !== "function") {
    throw new Error("cave_mastra_adapter_boundary_call_invalid");
  }
  return Object.freeze({
    target: value,
    request: request.value,
    settled: settled.value,
    failed: failed.value,
  });
}

function optionalCallback(value, key) {
  if (value === undefined) return undefined;
  if (typeof value !== "function") {
    throw new Error(`cave_mastra_adapter_callback_invalid:${key}`);
  }
  return value;
}

function observeCallback(callback, value, report, stage) {
  if (callback === undefined) return;
  observePromise(
    () => Reflect.apply(callback, undefined, [value]),
    report,
    stage,
  );
}

function observePromise(operation, report, stage) {
  try {
    void Promise.resolve(operation()).then(
      () => undefined,
      (error) => report(stage, error),
    );
  } catch (error) {
    report(stage, error);
  }
}

function observeExpectedFailure(operation, expected, report, stage) {
  try {
    void Promise.resolve(operation()).then(
      () => report(stage, new Error("cave_mastra_adapter_failure_not_rethrown")),
      (error) => {
        if (error !== expected) report(stage, error);
      },
    );
  } catch (error) {
    if (error !== expected) report(stage, error);
  }
}

function strictDataRecord(value, keys, errorCode) {
  if (!isObject(value)) throw new Error(errorCode);
  const allowed = new Set(keys);
  const output = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) throw new Error(errorCode);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) throw new Error(errorCode);
    output[key] = descriptor.value;
  }
  return output;
}

function data(value, key, errorCode) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor)) throw new Error(errorCode);
  return descriptor.value;
}

function optionalData(value, key, errorCode) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor)) throw new Error(errorCode);
  return descriptor.value;
}

function readNative(value, key) {
  if (!isObject(value)) throw new Error("cave_mastra_adapter_native_args_invalid");
  return data(value, key, "cave_mastra_adapter_native_args_invalid");
}

function readOptionalNative(value, key) {
  if (!isObject(value)) throw new Error("cave_mastra_adapter_native_args_invalid");
  return optionalData(value, key, "cave_mastra_adapter_native_args_invalid");
}

function readNonNegativeInteger(value, key) {
  const result = readNative(value, key);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error(`cave_mastra_adapter_native_args_invalid:${key}`);
  }
  return result;
}

function normalizedNativeId(prefix, value) {
  const candidate = `${prefix}-${value}`;
  if (candidate.length <= 256 && NORMALIZED_ID.test(candidate)) return candidate;
  return `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}

function isNativeValue(value) {
  return typeof value === "string" && value.length > 0 &&
    value.length <= MAX_NATIVE_VALUE_LENGTH && !/[\0\r\n]/u.test(value);
}

function isObject(value) {
  return value !== null && typeof value === "object";
}

export const manifest = adapterManifest;
export { createMastraAdapter as createAdapter };

const adapterPackage = defineAdapterPackage({
  manifest: adapterManifest,
  createAdapter: createMastraAdapter,
});

export default adapterPackage;
