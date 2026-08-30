import { randomUUID } from "node:crypto";
import {
  defineAdapterLifecycleEvent,
  defineAdapterLifecycleIdentity,
  defineAdapterPackage,
} from "@caveman-ai/adapter-kit";
import { captureModelBoundary } from "@caveman-ai/agent/model-boundary";
import { defineModelUsage } from "@caveman-ai/agent/model-usage";
import {
  AgentResultEvent,
  BeforeInvocationEvent,
  BeforeToolCallEvent,
  AfterToolCallEvent,
  InvokeModelStage,
} from "@strands-agents/sdk";
import { adapterManifest } from "./manifest.js";

const PLUGIN_NAME = "caveman-agent-sdk";
const OPTION_KEYS = Object.freeze([
  "model",
  "resolveModel",
  "modelBoundary",
  "role",
  "onLifecycle",
  "onModelUsage",
  "onObserverError",
]);
const MODEL_KEYS = Object.freeze(["provider", "model"]);
const REQUEST_KEYS = Object.freeze([
  "messages",
  "systemPrompt",
  "toolSpecs",
  "toolChoice",
  "projectedInputTokens",
  "dynamicTrailingBlocks",
]);
const REQUEST_REQUIRED_KEYS = Object.freeze(["messages", "toolSpecs"]);
const MAX_NATIVE_ID_LENGTH = 1_024;
const MAX_PENDING_OBSERVATIONS = 1_024;
const MAX_ORDINAL = Number.MAX_SAFE_INTEGER;

export const STRANDS_AGENTS_VERSION = "1.15.0";

/**
 * Create one structural Strands Plugin. Strands retains its model, router,
 * retries, tools, stream, and abort ownership; Caveman registers one native
 * InvokeModelStage.Wrap middleware and observe-only lifecycle hooks.
 */
export function createStrandsAgentsAdapter(options = {}) {
  const normalized = normalizeOptions(options);
  const runsByAgent = new WeakMap();
  const pending = new Set();
  let nextSequence = 0;

  const report = (stage, error) => {
    dispatchDetached(
      normalized.onObserverError,
      Object.freeze({ stage, error }),
      pending,
      undefined,
    );
  };

  const emit = (run, phase, identity) => {
    if (normalized.onLifecycle === undefined) return;
    if (nextSequence >= Number.MAX_SAFE_INTEGER) {
      report("lifecycle.sequence", new Error("cave_strands_adapter_sequence_exhausted"));
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
      report("lifecycle.normalize", error);
      return;
    }
    dispatchDetached(normalized.onLifecycle, event, pending, (error) => {
      report("lifecycle.sink", error);
    });
  };

  const openRun = (agent, invocationState) => {
    if (!isObject(agent) || !isObject(invocationState)) {
      report("run.identity", new Error("cave_strands_adapter_invocation_invalid"));
      return undefined;
    }
    let byInvocation = runsByAgent.get(agent);
    if (byInvocation === undefined) {
      byInvocation = new WeakMap();
      runsByAgent.set(agent, byInvocation);
    }
    const existing = byInvocation.get(invocationState);
    if (existing !== undefined && !existing.terminal) return existing;

    const runId = `strands:${randomUUID()}`;
    let identity;
    try {
      identity = defineAdapterLifecycleIdentity({
        runId,
        attempt: 1,
        replay: false,
        nativeIds: nativeIds({
          strandsAdapterRunId: runId,
          strandsAgentId: ownNativeString(agent, "id"),
        }),
      });
    } catch (error) {
      report("run.identity", error);
      return undefined;
    }
    const run = {
      identity,
      terminal: false,
      modelOrdinal: 0,
      toolOrdinal: 0,
      currentStepId: undefined,
      pendingTools: new Map(),
    };
    byInvocation.set(invocationState, run);
    emit(run, "run.started", identity);
    return run;
  };

  const findRun = (agent, invocationState) => {
    if (!isObject(agent) || !isObject(invocationState)) return undefined;
    return runsByAgent.get(agent)?.get(invocationState);
  };

  const closeRun = (agent, invocationState) => {
    const run = findRun(agent, invocationState);
    if (run === undefined || run.terminal) return;
    run.terminal = true;
    emit(run, "run.completed", run.identity);
    runsByAgent.get(agent)?.delete(invocationState);
  };

  const openModel = (context) => {
    const run = findRun(context.agent, context.invocationState) ??
      openRun(context.agent, context.invocationState);
    if (run === undefined) {
      throw new Error("cave_strands_adapter_run_identity_missing");
    }
    run.modelOrdinal = nextOrdinal(run.modelOrdinal, "model");
    const ordinal = run.modelOrdinal;
    const stepId = `strands-step-${ordinal}`;
    const modelCallId = `strands-model-${ordinal}`;
    run.currentStepId = stepId;
    const identity = defineAdapterLifecycleIdentity({
      runId: run.identity.runId,
      stepId,
      modelCallId,
      attempt: 1,
      replay: false,
      nativeIds: nativeIds({
        ...run.identity.nativeIds,
        strandsModelId: modelId(context.model),
      }),
    });
    emit(run, "model.requested", identity);
    return { run, identity };
  };

  const invokeModel = async function* (context, next) {
    let call;
    try {
      call = openModel(context);
    } catch (error) {
      if (normalized.modelBoundary !== undefined) throw error;
      report("model.identity", error);
    }
    let boundaryCall;
    let terminal = false;
    let resolvedModel;
    let signal;
    try {
      try {
        resolvedModel = resolveModel(normalized, context);
      } catch (error) {
        if (normalized.modelBoundary !== undefined) throw error;
        report("model.resolve", error);
      }
      if (resolvedModel === undefined && normalized.modelBoundary !== undefined) {
        throw new Error("cave_strands_adapter_model_identity_missing");
      }
      if (call === undefined && normalized.modelBoundary !== undefined) {
        throw new Error("cave_strands_adapter_model_identity_missing");
      }

      let nextContext = context;
      if (normalized.modelBoundary !== undefined) {
        signal = context.agent.cancelSignal;
        if (!(signal instanceof AbortSignal)) {
          throw new Error("cave_strands_adapter_abort_signal_invalid");
        }
        boundaryCall = await normalized.modelBoundary.prepare(
          modelRequest(context),
          Object.freeze({
            identity: call.identity,
            role: normalized.role,
            provider: resolvedModel.provider,
            model: resolvedModel.model,
            signal,
          }),
        );
        nextContext = preparedContext(context, boundaryCall.request);
      }

      const result = yield* next(nextContext);
      terminal = true;
      boundaryCall?.settled(result.result);
      if (call !== undefined) {
        emit(call.run, "model.responded", call.identity);
        observeUsage(
          normalized,
          resolvedModel,
          result.result?.metadata?.usage,
          call.identity,
          report,
          pending,
        );
      }
      return result;
    } catch (error) {
      if (!terminal) {
        terminal = true;
        boundaryCall?.failed(error);
        if (call !== undefined) emit(call.run, "model.error", call.identity);
      }
      throw error;
    } finally {
      if (!terminal) {
        terminal = true;
        const error = signal?.aborted && signal.reason !== undefined
          ? signal.reason
          : new Error("cave_strands_adapter_model_stream_closed");
        boundaryCall?.failed(error);
        if (call !== undefined) emit(call.run, "model.error", call.identity);
      }
    }
  };

  const startTool = (event) => {
    const run = findRun(event.agent, event.invocationState);
    if (run === undefined || run.terminal) return;
    const toolUseId = ownNativeString(event.toolUse, "toolUseId");
    if (toolUseId === undefined) {
      report("tool.identity", new Error("cave_strands_adapter_tool_identity_missing"));
      return;
    }
    run.toolOrdinal = nextOrdinal(run.toolOrdinal, "tool");
    const ordinal = run.toolOrdinal;
    const stepId = run.currentStepId ?? `strands-step-tool-${ordinal}`;
    const identity = defineAdapterLifecycleIdentity({
      runId: run.identity.runId,
      stepId,
      toolCallId: `strands-tool-${ordinal}`,
      attempt: 1,
      replay: false,
      nativeIds: nativeIds({
        ...run.identity.nativeIds,
        strandsToolUseId: toolUseId,
      }),
    });
    const queue = run.pendingTools.get(toolUseId) ?? [];
    queue.push(identity);
    run.pendingTools.set(toolUseId, queue);
    emit(run, "tool.started", identity);
  };

  const finishTool = (event) => {
    const run = findRun(event.agent, event.invocationState);
    if (run === undefined || run.terminal) return;
    const toolUseId = ownNativeString(event.toolUse, "toolUseId");
    if (toolUseId === undefined) return;
    const queue = run.pendingTools.get(toolUseId);
    const identity = queue?.shift();
    if (queue?.length === 0) run.pendingTools.delete(toolUseId);
    if (identity === undefined) {
      report("tool.sequence", new Error("cave_strands_adapter_tool_start_missing"));
      return;
    }
    const failed = event.error !== undefined || event.result?.status === "error";
    emit(run, failed ? "tool.error" : "tool.completed", identity);
  };

  const plugin = Object.freeze({
    name: PLUGIN_NAME,
    initAgent(agent) {
      agent.addHook(BeforeInvocationEvent, (event) => {
        openRun(event.agent, event.invocationState);
      });
      agent.addHook(AgentResultEvent, (event) => {
        closeRun(event.agent, event.invocationState);
      });
      agent.addMiddleware(InvokeModelStage.Wrap, invokeModel);
      if (normalized.onLifecycle !== undefined) {
        agent.addHook(BeforeToolCallEvent, (event) => {
          try {
            startTool(event);
          } catch (error) {
            report("tool.started", error);
          }
        });
        agent.addHook(AfterToolCallEvent, (event) => {
          try {
            finishTool(event);
          } catch (error) {
            report("tool.completed", error);
          }
        });
      }
    },
  });
  return plugin;
}

/** Normalize one native Strands usage object without inventing missing counts. */
export function normalizeStrandsUsage(usage, identity) {
  const model = normalizeModelIdentity(identity);
  if (usage === undefined || usage === null) {
    return defineModelUsage({
      schemaVersion: 1,
      ...model,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
      totalTokens: null,
      cost: { status: "unknown" },
    });
  }
  const value = dataRecord(
    usage,
    [
      "inputTokens",
      "outputTokens",
      "totalTokens",
      "cacheReadInputTokens",
      "cacheWriteInputTokens",
    ],
    [],
    "cave_strands_adapter_usage_invalid",
  );
  const upstreamInput = countOrNull(value.inputTokens, "inputTokens");
  const outputTokens = countOrNull(value.outputTokens, "outputTokens");
  const totalTokens = countOrNull(value.totalTokens, "totalTokens");
  const cacheReadTokens = countOrNull(value.cacheReadInputTokens, "cacheReadInputTokens");
  const cacheWriteTokens = countOrNull(value.cacheWriteInputTokens, "cacheWriteInputTokens");
  let inputTokens = null;

  if (upstreamInput !== null && outputTokens !== null && totalTokens !== null &&
      cacheReadTokens !== null && cacheWriteTokens !== null) {
    const cacheTokens = cacheReadTokens + cacheWriteTokens;
    if (upstreamInput + outputTokens === totalTokens) {
      if (upstreamInput < cacheTokens) {
        throw new Error("cave_strands_adapter_usage_invalid:inputTokens");
      }
      inputTokens = upstreamInput - cacheTokens;
    } else if (upstreamInput + outputTokens + cacheTokens === totalTokens) {
      inputTokens = upstreamInput;
    } else {
      throw new Error("cave_strands_adapter_usage_invalid:totalTokens");
    }
  }

  return defineModelUsage({
    schemaVersion: 1,
    ...model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens: null,
    totalTokens,
    cost: { status: "unknown" },
  });
}

function normalizeOptions(value) {
  const options = dataRecord(
    value,
    OPTION_KEYS,
    [],
    "cave_strands_adapter_options_invalid",
  );
  for (const key of ["resolveModel", "onLifecycle", "onModelUsage", "onObserverError"]) {
    if (options[key] !== undefined && typeof options[key] !== "function") {
      throw new Error(`cave_strands_adapter_options_invalid:${key}`);
    }
  }
  if (options.model !== undefined && options.resolveModel !== undefined) {
    throw new Error("cave_strands_adapter_options_invalid:model_resolver_conflict");
  }
  const role = options.role ?? "working";
  if (role !== "working" && role !== "compaction") {
    throw new Error("cave_strands_adapter_options_invalid:role");
  }
  const modelBoundary = captureModelBoundary(options.modelBoundary);
  const model = options.model === undefined ? undefined : normalizeModelIdentity(options.model);
  if ((modelBoundary !== undefined || options.onModelUsage !== undefined) &&
      model === undefined && options.resolveModel === undefined) {
    throw new Error("cave_strands_adapter_model_identity_required");
  }
  return Object.freeze({
    model,
    resolveModel: options.resolveModel,
    modelBoundary,
    role,
    onLifecycle: options.onLifecycle,
    onModelUsage: options.onModelUsage,
    onObserverError: options.onObserverError,
  });
}

function resolveModel(options, context) {
  if (options.model !== undefined) return options.model;
  if (options.resolveModel === undefined) return undefined;
  const nativeModelId = modelId(context.model) ?? null;
  const resolved = Reflect.apply(options.resolveModel, undefined, [Object.freeze({
    model: context.model,
    modelId: nativeModelId,
  })]);
  return resolved === undefined || resolved === null
    ? undefined
    : normalizeModelIdentity(resolved);
}

function normalizeModelIdentity(value) {
  const identity = dataRecord(
    value,
    MODEL_KEYS,
    MODEL_KEYS,
    "cave_strands_adapter_model_invalid",
  );
  const usage = defineModelUsage({
    schemaVersion: 1,
    provider: identity.provider,
    model: identity.model,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
    totalTokens: null,
    cost: { status: "unknown" },
  });
  return Object.freeze({ provider: usage.provider, model: usage.model });
}

function modelRequest(context) {
  return Object.freeze({
    messages: Object.freeze([...context.messages]),
    ...(context.systemPrompt === undefined ? {} : { systemPrompt: context.systemPrompt }),
    toolSpecs: Object.freeze([...context.toolSpecs]),
    ...(context.toolChoice === undefined ? {} : { toolChoice: context.toolChoice }),
    ...(context.projectedInputTokens === undefined
      ? {}
      : { projectedInputTokens: context.projectedInputTokens }),
    ...(context.dynamicTrailingBlocks === undefined
      ? {}
      : { dynamicTrailingBlocks: context.dynamicTrailingBlocks }),
  });
}

function preparedContext(context, value) {
  const request = dataRecord(
    value,
    REQUEST_KEYS,
    REQUEST_REQUIRED_KEYS,
    "cave_strands_adapter_model_request_invalid",
  );
  validateDenseArray(request.messages, "messages");
  validateDenseArray(request.toolSpecs, "toolSpecs");
  if (request.projectedInputTokens !== undefined &&
      (!Number.isSafeInteger(request.projectedInputTokens) || request.projectedInputTokens < 0)) {
    throw new Error("cave_strands_adapter_model_request_invalid:projectedInputTokens");
  }
  if (request.dynamicTrailingBlocks !== undefined &&
      (!Number.isSafeInteger(request.dynamicTrailingBlocks) || request.dynamicTrailingBlocks < 0)) {
    throw new Error("cave_strands_adapter_model_request_invalid:dynamicTrailingBlocks");
  }
  return {
    agent: context.agent,
    model: context.model,
    messages: request.messages,
    ...(request.systemPrompt === undefined ? {} : { systemPrompt: request.systemPrompt }),
    toolSpecs: request.toolSpecs,
    ...(request.toolChoice === undefined ? {} : { toolChoice: request.toolChoice }),
    invocationState: context.invocationState,
    ...(request.projectedInputTokens === undefined
      ? {}
      : { projectedInputTokens: request.projectedInputTokens }),
    ...(request.dynamicTrailingBlocks === undefined
      ? {}
      : { dynamicTrailingBlocks: request.dynamicTrailingBlocks }),
  };
}

function observeUsage(options, model, nativeUsage, identity, report, pending) {
  if (options.onModelUsage === undefined) return;
  if (model === undefined) {
    report("usage.identity", new Error("cave_strands_adapter_model_identity_missing"));
    return;
  }
  let usage;
  try {
    usage = normalizeStrandsUsage(nativeUsage, model);
  } catch (error) {
    report("usage.normalize", error);
    return;
  }
  dispatchDetached(
    options.onModelUsage,
    Object.freeze({ usage, identity }),
    pending,
    (error) => report("usage.sink", error),
  );
}

function dataRecord(value, allowed, required, code) {
  if (!isObject(value) || Array.isArray(value)) throw new Error(code);
  let descriptors;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new Error(code);
  }
  const allowedSet = new Set(allowed);
  const record = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || !allowedSet.has(key)) throw new Error(code);
    const descriptor = descriptors[key];
    if (!("value" in descriptor)) throw new Error(code);
    record[key] = descriptor.value;
  }
  for (const key of required) {
    if (!Object.hasOwn(record, key)) throw new Error(code);
  }
  return record;
}

function validateDenseArray(value, field) {
  if (!Array.isArray(value)) {
    throw new Error(`cave_strands_adapter_model_request_invalid:${field}`);
  }
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) {
      throw new Error(`cave_strands_adapter_model_request_invalid:${field}`);
    }
  }
}

function countOrNull(value, field) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`cave_strands_adapter_usage_invalid:${field}`);
  }
  return value;
}

function nextOrdinal(value, kind) {
  if (!Number.isSafeInteger(value) || value < 0 || value >= MAX_ORDINAL) {
    throw new Error(`cave_strands_adapter_${kind}_identity_exhausted`);
  }
  return value + 1;
}

function modelId(model) {
  try {
    const value = model?.modelId;
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function ownNativeString(value, key) {
  if (!isObject(value)) return undefined;
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    return undefined;
  }
  const native = descriptor !== undefined && "value" in descriptor
    ? descriptor.value
    : undefined;
  return typeof native === "string" && native.length > 0 &&
      native.length <= MAX_NATIVE_ID_LENGTH && !/[\0\r\n]/u.test(native)
    ? native
    : undefined;
}

function nativeIds(values) {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) =>
      typeof value === "string" && value.length > 0 &&
      value.length <= MAX_NATIVE_ID_LENGTH && !/[\0\r\n]/u.test(value)),
  );
}

function dispatchDetached(sink, value, pending, onError) {
  if (sink === undefined) return;
  if (pending.size >= MAX_PENDING_OBSERVATIONS) {
    onError?.(new Error("cave_strands_adapter_observer_capacity"));
    return;
  }
  let result;
  try {
    result = Reflect.apply(sink, undefined, [value]);
  } catch (error) {
    onError?.(error);
    return;
  }
  let task;
  try {
    task = Promise.resolve(result);
  } catch (error) {
    onError?.(error);
    return;
  }
  pending.add(task);
  task.then(
    () => pending.delete(task),
    (error) => {
      pending.delete(task);
      onError?.(error);
    },
  );
}

function isObject(value) {
  return typeof value === "object" && value !== null;
}

const adapterPackage = defineAdapterPackage({
  manifest: adapterManifest,
  createAdapter: createStrandsAgentsAdapter,
});

export const manifest = adapterPackage.manifest;
export const createAdapter = adapterPackage.createAdapter;
export default adapterPackage;
