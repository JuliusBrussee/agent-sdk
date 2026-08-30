import {
  defineAdapterLifecycleEvent,
  defineAdapterLifecycleIdentity,
  defineAdapterPackage,
} from "@caveman-ai/adapter-kit";
import { defineModelUsage } from "@caveman-ai/agent/model-usage";
import { adapterManifest } from "./manifest.js";

const OPTION_KEYS = new Set([
  "modelBoundary",
  "onLifecycleEvent",
  "onModelUsage",
  "role",
]);
const CALLBACK_KEYS = Object.freeze([
  "onStart",
  "onStepStart",
  "onToolExecutionStart",
  "onToolExecutionEnd",
  "onStepEnd",
  "onEnd",
]);
const MAX_ACTIVE_RUNS = 1_024;
const MAX_PENDING_STEPS = 4_096;
const MAX_NATIVE_ID_LENGTH = 1_024;
const NEVER_ABORT_SIGNAL = new AbortController().signal;

export const VERCEL_AI_SDK_VERSION = "7.0.84";

/**
 * Create native Vercel AI SDK fragments. Vercel keeps ownership of its model,
 * loop, retries, tools, aborts, and streams; Caveman only intercepts the model
 * request and observes lifecycle/usage.
 */
export function createVercelAISDKAdapter(options = {}) {
  const normalized = normalizeOptions(options);
  const preparedByRequest = new WeakMap();
  const stepByPrompt = new WeakMap();
  const runs = new Map();
  const pendingSteps = [];
  let nextScope = 0;
  let nextSequence = 0;

  const allocate = (kind) => {
    if (nextScope >= Number.MAX_SAFE_INTEGER) {
      throw new Error("cave_vercel_adapter_identity_exhausted");
    }
    nextScope += 1;
    return `vercel-${kind}-${nextScope}`;
  };

  const emit = (phase, identity) => {
    if (normalized.onLifecycleEvent === undefined) return;
    if (nextSequence >= Number.MAX_SAFE_INTEGER) return;
    try {
      const event = defineAdapterLifecycleEvent({
        schemaVersion: 1,
        seq: nextSequence,
        phase,
        identity,
      });
      nextSequence += 1;
      observeBestEffort(() => normalized.onLifecycleEvent(event));
    } catch {
      // Translation failure stays diagnostic-only.
    }
  };

  const observeUsage = (usage, provider, model) => {
    if (normalized.onModelUsage === undefined) return;
    const normalizedUsage = normalizeVercelUsage(usage, { provider, model });
    observeBestEffort(() => normalized.onModelUsage(normalizedUsage));
  };

  const openRun = (event) => {
    if (!isNativeId(event?.callId)) return;
    if (runs.size >= MAX_ACTIVE_RUNS) {
      const oldest = runs.keys().next().value;
      if (oldest !== undefined) closeRunState(runs.get(oldest));
    }
    const identity = defineAdapterLifecycleIdentity({
      runId: allocate("run"),
      attempt: 1,
      replay: false,
      nativeIds: { vercelCallId: event.callId },
    });
    const state = {
      nativeCallId: event.callId,
      identity,
      steps: new Map(),
      currentStep: undefined,
      tools: new Map(),
    };
    runs.set(event.callId, state);
    emit("run.started", identity);
  };

  const openStep = (event) => {
    const run = runs.get(event?.callId);
    if (run === undefined || !Number.isSafeInteger(event?.stepNumber) ||
        event.stepNumber < 0 || !isNativeId(event?.provider) ||
        !isNativeId(event?.modelId)) {
      return;
    }
    const identity = defineAdapterLifecycleIdentity({
      runId: run.identity.runId,
      stepId: allocate("step"),
      modelCallId: allocate("model"),
      attempt: 1,
      replay: false,
      nativeIds: {
        vercelCallId: event.callId,
        vercelStepNumber: String(event.stepNumber),
      },
    });
    const step = {
      run,
      stepNumber: event.stepNumber,
      provider: event.provider,
      model: event.modelId,
      identity,
      status: "open",
      prompt: undefined,
    };
    run.steps.set(event.stepNumber, step);
    run.currentStep = step;
    pendingSteps.push(step);
    if (pendingSteps.length > MAX_PENDING_STEPS) pendingSteps.shift();
    emit("model.requested", identity);
  };

  const claimStep = (params, model) => {
    const prompt = isObject(params?.prompt) ? params.prompt : undefined;
    const mapped = prompt === undefined ? undefined : stepByPrompt.get(prompt);
    if (mapped !== undefined && mapped.provider === model.provider &&
        mapped.model === model.modelId && mapped.status === "error") {
      mapped.identity = defineAdapterLifecycleIdentity({
        ...mapped.identity,
        attempt: mapped.identity.attempt + 1,
      });
      mapped.status = "open";
      emit("model.requested", mapped.identity);
      return mapped;
    }

    const index = pendingSteps.findIndex(
      (step) => step.provider === model.provider && step.model === model.modelId,
    );
    if (index === -1) return undefined;
    const [step] = pendingSteps.splice(index, 1);
    if (prompt !== undefined) {
      step.prompt = prompt;
      stepByPrompt.set(prompt, step);
    }
    return step;
  };

  const finishModel = (step, phase) => {
    if (step === undefined || step.status !== "open") return;
    step.status = phase === "model.responded" ? "responded" : "error";
    emit(phase, step.identity);
  };

  const createBoundaryIdentity = (step) => {
    if (step !== undefined) return step.identity;
    return defineAdapterLifecycleIdentity({
      runId: allocate("boundary-run"),
      stepId: allocate("boundary-step"),
      modelCallId: allocate("boundary-model"),
      attempt: 1,
      replay: false,
      nativeIds: {},
    });
  };

  const transformParams = async ({ params, model }) => {
    const step = claimStep(params, model);
    const record = { step, boundaryCall: undefined };
    let request = params;
    try {
      if (normalized.modelBoundary !== undefined) {
        const context = Object.freeze({
          identity: createBoundaryIdentity(step),
          role: normalized.role,
          provider: model.provider,
          model: model.modelId,
          signal: params.abortSignal ?? NEVER_ABORT_SIGNAL,
        });
        record.boundaryCall = await Reflect.apply(
          normalized.modelBoundary.prepare,
          normalized.modelBoundary.receiver,
          [params, context],
        );
        request = record.boundaryCall?.request;
        if (!isObject(request)) {
          throw new Error("cave_vercel_adapter_model_request_invalid");
        }
        if (request.abortSignal !== params.abortSignal) {
          throw new Error("cave_vercel_adapter_abort_signal_changed");
        }
      }
      enqueuePrepared(preparedByRequest, request, record);
      return request;
    } catch (error) {
      finishModel(step, "model.error");
      throw error;
    }
  };

  const wrapGenerate = async ({ doGenerate, params, model }) => {
    const record = takePrepared(preparedByRequest, params);
    try {
      const result = await doGenerate();
      observeBestEffort(() => observeUsage(result.usage, model.provider, model.modelId));
      finishModel(record.step, "model.responded");
      settleBoundary(record, result);
      return result;
    } catch (error) {
      finishModel(record?.step, "model.error");
      failBoundary(record, error);
      throw error;
    }
  };

  const wrapStream = async ({ doStream, params, model }) => {
    const record = takePrepared(preparedByRequest, params);
    try {
      const result = await doStream();
      return wrapNativeStream({
        result,
        record,
        provider: model.provider,
        model: model.modelId,
        onUsage: observeUsage,
        onResponded: () => finishModel(record.step, "model.responded"),
        onError: (error) => {
          finishModel(record.step, "model.error");
          failBoundary(record, error);
        },
        onSettled: () => settleBoundary(record, result),
      });
    } catch (error) {
      finishModel(record?.step, "model.error");
      failBoundary(record, error);
      throw error;
    }
  };

  const middleware = Object.freeze({
    specificationVersion: "v4",
    transformParams,
    wrapGenerate,
    wrapStream,
  });

  const composeAgentCallbacks = (existing = {}) => {
    const captured = captureCallbacks(existing);
    if (normalized.onLifecycleEvent === undefined) {
      return Object.freeze(Object.fromEntries(
        CALLBACK_KEYS
          .filter((key) => captured[key] !== undefined)
          .map((key) => [key, captured[key]]),
      ));
    }
    return Object.freeze({
      onStart: composeCallback(captured.onStart, openRun),
      onStepStart: composeCallback(captured.onStepStart, openStep),
      onToolExecutionStart: composeCallback(
        captured.onToolExecutionStart,
        (event) => openTool(runs, allocate, emit, event),
      ),
      onToolExecutionEnd: composeCallback(
        captured.onToolExecutionEnd,
        (event) => finishTool(runs, emit, event),
      ),
      onStepEnd: composeCallback(captured.onStepEnd, (event) => {
        const step = runs.get(event?.callId)?.steps.get(event?.stepNumber);
        if (step === undefined || step.status !== "open") return;
        observeBestEffort(() => observeUsage(
          event.usage,
          event.model?.provider ?? step.provider,
          event.model?.modelId ?? step.model,
        ));
        finishModel(step, "model.responded");
      }),
      onEnd: composeCallback(captured.onEnd, (event) => {
        const run = runs.get(event?.callId);
        if (run === undefined) return;
        emit("run.completed", run.identity);
        closeRunState(run);
      }),
    });
  };

  function closeRunState(run) {
    if (run === undefined) return;
    runs.delete(run.nativeCallId);
    for (let index = pendingSteps.length - 1; index >= 0; index--) {
      if (pendingSteps[index]?.run === run) pendingSteps.splice(index, 1);
    }
    for (const step of run.steps.values()) {
      if (step.prompt !== undefined) stepByPrompt.delete(step.prompt);
    }
  }

  return Object.freeze({ middleware, composeAgentCallbacks });
}

/** Convert Vercel V4 or public AI SDK usage without inventing zero counts. */
export function normalizeVercelUsage(usage, identity) {
  const provider = ownData(identity, "provider");
  const model = ownData(identity, "model");
  const input = ownData(usage, "inputTokens");
  const output = ownData(usage, "outputTokens");
  let inputTokens;
  let cacheReadTokens;
  let cacheWriteTokens;
  let outputTokens;
  let reasoningTokens;

  if (isObject(input)) {
    inputTokens = nullableCount(ownData(input, "noCache"));
    cacheReadTokens = nullableCount(ownData(input, "cacheRead"));
    cacheWriteTokens = nullableCount(ownData(input, "cacheWrite"));
    if (!isObject(output)) throw new Error("cave_vercel_adapter_usage_invalid");
    outputTokens = nullableCount(ownData(output, "total"));
    reasoningTokens = nullableCount(ownData(output, "reasoning"));
  } else {
    const inputDetails = ownData(usage, "inputTokenDetails");
    const outputDetails = ownData(usage, "outputTokenDetails");
    if (!isObject(inputDetails) || !isObject(outputDetails)) {
      throw new Error("cave_vercel_adapter_usage_invalid");
    }
    inputTokens = nullableCount(ownData(inputDetails, "noCacheTokens"));
    cacheReadTokens = nullableCount(ownData(inputDetails, "cacheReadTokens"));
    cacheWriteTokens = nullableCount(ownData(inputDetails, "cacheWriteTokens"));
    outputTokens = nullableCount(output);
    reasoningTokens = nullableCount(ownData(outputDetails, "reasoningTokens"));
  }

  const disjoint = [
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
  ];
  const complete = disjoint.every((count) => count !== null);
  const totalTokens = complete
    ? inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
    : null;
  return defineModelUsage({
    schemaVersion: 1,
    provider,
    model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    totalTokens,
    cost: complete ? { status: "unpriced" } : { status: "unknown" },
  });
}

function normalizeOptions(value) {
  if (!isObject(value) || Array.isArray(value)) {
    throw new Error("cave_vercel_adapter_options_invalid");
  }
  let descriptors;
  let keys;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
    keys = Reflect.ownKeys(value);
  } catch {
    throw new Error("cave_vercel_adapter_options_invalid");
  }
  if (keys.some((key) => typeof key !== "string" || !OPTION_KEYS.has(key))) {
    throw new Error("cave_vercel_adapter_options_invalid");
  }
  for (const key of keys) {
    if (!("value" in descriptors[key])) {
      throw new Error("cave_vercel_adapter_options_invalid");
    }
  }
  const modelBoundary = descriptors.modelBoundary?.value;
  const onLifecycleEvent = descriptors.onLifecycleEvent?.value;
  const onModelUsage = descriptors.onModelUsage?.value;
  const role = descriptors.role?.value ?? "working";
  if (onLifecycleEvent !== undefined && typeof onLifecycleEvent !== "function" ||
      onModelUsage !== undefined && typeof onModelUsage !== "function" ||
      role !== "working" && role !== "compaction") {
    throw new Error("cave_vercel_adapter_options_invalid");
  }

  let normalizedBoundary;
  if (modelBoundary !== undefined) {
    if (!isObject(modelBoundary)) {
      throw new Error("cave_vercel_adapter_model_boundary_invalid");
    }
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(modelBoundary, "prepare");
    } catch {
      throw new Error("cave_vercel_adapter_model_boundary_invalid");
    }
    if (descriptor === undefined || !("value" in descriptor) ||
        typeof descriptor.value !== "function") {
      throw new Error("cave_vercel_adapter_model_boundary_invalid");
    }
    normalizedBoundary = Object.freeze({
      receiver: modelBoundary,
      prepare: descriptor.value,
    });
  }
  return Object.freeze({
    modelBoundary: normalizedBoundary,
    onLifecycleEvent,
    onModelUsage,
    role,
  });
}

function captureCallbacks(value) {
  if (!isObject(value) || Array.isArray(value)) {
    throw new Error("cave_vercel_adapter_callbacks_invalid");
  }
  let descriptors;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new Error("cave_vercel_adapter_callbacks_invalid");
  }
  const captured = {};
  for (const key of CALLBACK_KEYS) {
    const descriptor = descriptors[key];
    if (descriptor === undefined) {
      captured[key] = undefined;
      continue;
    }
    if (!("value" in descriptor) || typeof descriptor.value !== "function") {
      throw new Error(`cave_vercel_adapter_callback_invalid:${key}`);
    }
    captured[key] = descriptor.value;
  }
  return captured;
}

function composeCallback(existing, observe) {
  return function composedVercelCallback(event) {
    const result = existing === undefined
      ? undefined
      : Reflect.apply(existing, this, [event]);
    observeBestEffort(() => observe(event));
    return result;
  };
}

function openTool(runs, allocate, emit, event) {
  const run = runs.get(event?.callId);
  const step = run?.currentStep;
  const nativeToolCallId = event?.toolCall?.toolCallId;
  if (run === undefined || step === undefined || !isNativeId(nativeToolCallId)) return;
  const identity = defineAdapterLifecycleIdentity({
    runId: run.identity.runId,
    stepId: step.identity.stepId,
    toolCallId: allocate("tool"),
    attempt: 1,
    replay: false,
    nativeIds: {
      vercelCallId: event.callId,
      vercelToolCallId: nativeToolCallId,
    },
  });
  run.tools.set(nativeToolCallId, { identity, open: true });
  emit("tool.started", identity);
}

function finishTool(runs, emit, event) {
  const run = runs.get(event?.callId);
  const nativeToolCallId = event?.toolCall?.toolCallId;
  const tool = run?.tools.get(nativeToolCallId);
  if (tool === undefined || !tool.open) return;
  tool.open = false;
  emit(event?.toolOutput?.type === "tool-error" ? "tool.error" : "tool.completed", tool.identity);
}

function wrapNativeStream({
  result,
  record,
  provider,
  model,
  onUsage,
  onResponded,
  onError,
  onSettled,
}) {
  if (!isObject(result) || !(result.stream instanceof ReadableStream)) {
    throw new Error("cave_vercel_adapter_stream_invalid");
  }
  const reader = result.stream.getReader();
  let terminal = false;
  let cancelled = false;
  let streamedError;

  const finishSuccess = () => {
    if (terminal) return;
    terminal = true;
    onResponded();
    onSettled();
  };
  const finishError = (error) => {
    if (terminal) return;
    terminal = true;
    onError(error);
  };

  const stream = new ReadableStream({
    async pull(controller) {
      let read;
      try {
        read = await reader.read();
      } catch (error) {
        if (cancelled) return;
        finishError(error);
        controller.error(error);
        return;
      }
      if (cancelled) return;
      if (read.done) {
        if (!terminal) {
          finishError(streamedError ?? new Error("cave_vercel_adapter_stream_finish_missing"));
        }
        controller.close();
        return;
      }

      try {
        const part = read.value;
        if (part?.type === "error" && streamedError === undefined) {
          streamedError = part.error;
        }
        if (part?.type === "finish") {
          observeBestEffort(() => onUsage(part.usage, provider, model));
          // A provider error arrives as an `error` part followed by a normal
          // `finish` whose reason is `error`. Reporting that as a settled
          // response would attest a model call that actually failed.
          const failed = streamedError !== undefined ||
            part.finishReason?.unified === "error";
          if (failed) {
            finishError(
              streamedError ?? new Error("cave_vercel_adapter_stream_finish_error"),
            );
          } else {
            finishSuccess();
          }
        }
        controller.enqueue(part);
      } catch (error) {
        finishError(error);
        controller.error(error);
      }
    },
    cancel(reason) {
      cancelled = true;
      finishError(reason ?? new Error("cave_vercel_adapter_stream_cancelled"));
      return reader.cancel(reason);
    },
  }, { highWaterMark: 0 });

  return { ...result, stream };
}

function enqueuePrepared(map, request, record) {
  let queue = map.get(request);
  if (queue === undefined) {
    queue = [];
    map.set(request, queue);
  }
  queue.push(record);
}

function takePrepared(map, request) {
  const queue = map.get(request);
  const record = queue?.shift();
  if (queue?.length === 0) map.delete(request);
  if (record === undefined) {
    throw new Error("cave_vercel_adapter_boundary_state_missing");
  }
  return record;
}

function settleBoundary(record, response) {
  if (record?.boundaryCall === undefined) return;
  observeBestEffort(() => record.boundaryCall.settled(response));
}

function failBoundary(record, error) {
  if (record?.boundaryCall === undefined) return;
  observeBestEffort(() => record.boundaryCall.failed(error));
}

function observeBestEffort(observe) {
  try {
    void Promise.resolve(observe()).then(
      () => undefined,
      () => undefined,
    );
  } catch {
    // Diagnostics never control Vercel execution.
  }
}

function ownData(value, key) {
  if (!isObject(value)) throw new Error("cave_vercel_adapter_usage_invalid");
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    throw new Error("cave_vercel_adapter_usage_invalid");
  }
  if (descriptor === undefined || !("value" in descriptor)) {
    throw new Error("cave_vercel_adapter_usage_invalid");
  }
  return descriptor.value;
}

function nullableCount(value) {
  return value === undefined ? null : value;
}

function isNativeId(value) {
  return typeof value === "string" && value.length > 0 &&
    value.length <= MAX_NATIVE_ID_LENGTH;
}

function isObject(value) {
  return value !== null && typeof value === "object";
}

const adapterPackage = defineAdapterPackage({
  manifest: adapterManifest,
  createAdapter: createVercelAISDKAdapter,
});

export const manifest = adapterPackage.manifest;
export const createAdapter = adapterPackage.createAdapter;
export default adapterPackage;
