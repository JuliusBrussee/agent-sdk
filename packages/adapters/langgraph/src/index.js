import {
  defineAdapterLifecycleEvent,
  defineAdapterLifecycleIdentity,
  defineAdapterPackage,
} from "@caveman-ai/adapter-kit";
import { defineModelUsage } from "@caveman-ai/agent/model-usage";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { CallbackManager } from "@langchain/core/callbacks/manager";
import { AIMessage } from "@langchain/core/messages";
import { adapterManifest } from "./manifest.js";

const OPTION_KEYS = Object.freeze([
  "model",
  "resolveModel",
  "onLifecycle",
  "onUsage",
  "onStreamEvent",
  "onObserverError",
]);
const MODEL_KEYS = Object.freeze(["provider", "model"]);
const EMPTY_TRANSFORMER_PROJECTION = Object.freeze({});

class CavemanLangGraphCallbackHandler extends BaseCallbackHandler {
  name = "caveman_langgraph";

  constructor(observer) {
    super({ raiseError: false });
    this.observer = observer;
    this.roots = new Map();
    this.rootByNativeRun = new Map();
    this.modelRuns = new Map();
    this.toolRuns = new Map();
  }

  handleChainStart(
    _chain,
    _inputs,
    runId,
    parentRunId,
    _tags,
    _metadata,
    _runType,
    _runName,
  ) {
    // Core 1.2.9 runtime dispatches parentRunId fourth. Its declaration file
    // places runType there; native integration tests pin actual dispatch.
    if (!this.observer.needsCallbacks || !isNativeId(runId)) return;
    const parentRoot = isNativeId(parentRunId)
      ? this.rootByNativeRun.get(parentRunId)
      : undefined;
    const rootId = parentRoot ?? runId;
    let root = this.roots.get(rootId);
    if (root === undefined) {
      const identity = safely(
        () => runIdentity(rootId),
        this.observer.report,
        "lifecycle.identity",
      );
      if (identity === undefined) return;
      root = { nativeRunId: rootId, seq: 0, members: new Set() };
      this.roots.set(rootId, root);
      this.emit(root, "run.started", identity);
    }
    root.members.add(runId);
    this.rootByNativeRun.set(runId, rootId);
  }

  handleChainEnd(_outputs, runId) {
    this.finishChain(runId, "run.completed");
  }

  handleChainError(_error, runId) {
    this.finishChain(runId, "run.error");
  }

  handleLLMStart(llm, _prompts, runId, parentRunId, _extraParams, _tags, metadata) {
    this.startModel(llm, runId, parentRunId, metadata);
  }

  handleChatModelStart(llm, _messages, runId, parentRunId, _extraParams, _tags, metadata) {
    this.startModel(llm, runId, parentRunId, metadata);
  }

  handleLLMEnd(output, runId) {
    const modelRun = this.modelRuns.get(runId);
    if (modelRun === undefined) return;
    const root = this.roots.get(modelRun.rootId);
    if (root !== undefined) this.emit(root, "model.responded", modelRun.identity);
    this.emitUsage(output, modelRun);
    this.modelRuns.delete(runId);
  }

  handleLLMError(_error, runId) {
    const modelRun = this.modelRuns.get(runId);
    if (modelRun === undefined) return;
    const root = this.roots.get(modelRun.rootId);
    if (root !== undefined) this.emit(root, "model.error", modelRun.identity);
    this.modelRuns.delete(runId);
  }

  handleToolStart(_tool, _input, runId, parentRunId, _tags, _metadata, _runName, toolCallId) {
    const scope = this.scopeFor(runId, parentRunId);
    if (scope === undefined) return;
    const identity = scopedIdentity({
      rootId: scope.rootId,
      stepId: scope.stepId,
      toolCallId: runId,
      nativeIds: {
        langchainRunId: scope.rootId,
        langchainToolRunId: runId,
        langchainParentRunId: scope.stepId,
        ...(isNativeId(toolCallId) ? { langchainToolCallId: toolCallId } : {}),
      },
    }, this.observer.report);
    if (identity === undefined) return;
    this.toolRuns.set(runId, { rootId: scope.rootId, identity });
    const root = this.roots.get(scope.rootId);
    if (root !== undefined) this.emit(root, "tool.started", identity);
  }

  handleToolEnd(_output, runId) {
    this.finishTool(runId, "tool.completed");
  }

  handleToolError(_error, runId) {
    this.finishTool(runId, "tool.error");
  }

  startModel(llm, runId, parentRunId, metadata) {
    const scope = this.scopeFor(runId, parentRunId);
    if (scope === undefined) return;
    const identity = scopedIdentity({
      rootId: scope.rootId,
      stepId: scope.stepId,
      modelCallId: runId,
      nativeIds: {
        langchainRunId: scope.rootId,
        langchainModelRunId: runId,
        langchainParentRunId: scope.stepId,
      },
    }, this.observer.report);
    if (identity === undefined) return;
    const modelIdentity = this.observer.resolveModel({
      nativeRunId: runId,
      parentRunId: scope.stepId,
      serializedId: serializedId(llm),
      providerHint: ownString(metadata, "ls_provider"),
      modelHint: ownString(metadata, "ls_model_name"),
    });
    this.modelRuns.set(runId, {
      rootId: scope.rootId,
      identity,
      modelIdentity,
    });
    const root = this.roots.get(scope.rootId);
    if (root !== undefined) this.emit(root, "model.requested", identity);
  }

  scopeFor(runId, parentRunId) {
    if (!this.observer.needsCallbacks || !isNativeId(runId) || !isNativeId(parentRunId)) {
      return undefined;
    }
    const rootId = this.rootByNativeRun.get(parentRunId);
    if (rootId === undefined) return undefined;
    return { rootId, stepId: parentRunId };
  }

  finishChain(runId, phase) {
    if (!isNativeId(runId)) return;
    const rootId = this.rootByNativeRun.get(runId);
    if (rootId === undefined) return;
    if (runId !== rootId) {
      this.rootByNativeRun.delete(runId);
      return;
    }
    const root = this.roots.get(rootId);
    if (root === undefined) return;
    const identity = safely(
      () => runIdentity(rootId),
      this.observer.report,
      "lifecycle.identity",
    );
    if (identity !== undefined) this.emit(root, phase, identity);
    for (const member of root.members) this.rootByNativeRun.delete(member);
    this.roots.delete(rootId);
    for (const [nativeRunId, modelRun] of this.modelRuns) {
      if (modelRun.rootId === rootId) this.modelRuns.delete(nativeRunId);
    }
    for (const [nativeRunId, toolRun] of this.toolRuns) {
      if (toolRun.rootId === rootId) this.toolRuns.delete(nativeRunId);
    }
  }

  finishTool(runId, phase) {
    const toolRun = this.toolRuns.get(runId);
    if (toolRun === undefined) return;
    const root = this.roots.get(toolRun.rootId);
    if (root !== undefined) this.emit(root, phase, toolRun.identity);
    this.toolRuns.delete(runId);
  }

  emit(root, phase, identity) {
    const event = safely(
      () => defineAdapterLifecycleEvent({
        schemaVersion: 1,
        seq: root.seq++,
        phase,
        identity,
      }),
      this.observer.report,
      "lifecycle.normalize",
    );
    if (event !== undefined) {
      dispatch(this.observer.onLifecycle, event, this.observer.report, "lifecycle.sink");
    }
  }

  emitUsage(output, modelRun) {
    if (this.observer.onUsage === undefined) return;
    const message = firstAIMessage(output);
    const responseModel = modelIdentityFromMessage(message);
    const modelIdentity = modelRun.modelIdentity ?? responseModel;
    if (modelIdentity === undefined) return;
    const usage = safely(
      () => usageFromMessage(message, modelIdentity),
      this.observer.report,
      "usage.normalize",
    );
    if (usage === undefined) return;
    dispatch(
      this.observer.onUsage,
      Object.freeze({ usage, identity: modelRun.identity }),
      this.observer.report,
      "usage.sink",
    );
  }
}

export function createLangGraphAdapter(options = {}) {
  const normalized = normalizeOptions(options);
  const report = createReporter(normalized.onObserverError);
  const resolveModel = createModelResolver(normalized, report);
  const observer = Object.freeze({
    onLifecycle: normalized.onLifecycle,
    onUsage: normalized.onUsage,
    report,
    resolveModel,
    needsCallbacks: normalized.onLifecycle !== undefined || normalized.onUsage !== undefined,
  });
  const callbackHandler = new CavemanLangGraphCallbackHandler(observer);
  const transformerFactory = () => createStreamTransformer(
    normalized.onStreamEvent,
    report,
  );
  const callbacks = Object.freeze([callbackHandler]);
  const transformers = Object.freeze([transformerFactory]);

  const composeCallbacks = (existing) => {
    if (existing === undefined) return callbacks;
    if (Array.isArray(existing)) return Object.freeze([...existing, callbackHandler]);
    if (existing instanceof CallbackManager) return existing.copy([callbackHandler], true);
    throw new Error("cave_langgraph_callbacks_invalid");
  };

  const composeTransformers = (existing = []) => {
    if (!Array.isArray(existing) || existing.some((entry) => typeof entry !== "function")) {
      throw new Error("cave_langgraph_transformers_invalid");
    }
    return Object.freeze([...existing, transformerFactory]);
  };

  return Object.freeze({
    callbackHandler,
    callbacks,
    transformer: transformerFactory,
    transformers,
    composeCallbacks,
    composeConfig(config = {}) {
      if (config === null || typeof config !== "object" || Array.isArray(config)) {
        throw new Error("cave_langgraph_config_invalid");
      }
      return {
        ...config,
        callbacks: composeCallbacks(config.callbacks),
      };
    },
    composeTransformers,
  });
}

function normalizeOptions(value) {
  const options = ownDataRecord(value, OPTION_KEYS, "cave_langgraph_options_invalid");
  for (const key of [
    "resolveModel",
    "onLifecycle",
    "onUsage",
    "onStreamEvent",
    "onObserverError",
  ]) {
    if (options[key] !== undefined && typeof options[key] !== "function") {
      throw new Error(`cave_langgraph_options_invalid:${key}`);
    }
  }
  if (options.model !== undefined && options.resolveModel !== undefined) {
    throw new Error("cave_langgraph_options_invalid:model_resolver_conflict");
  }
  return Object.freeze({
    ...options,
    ...(options.model === undefined ? {} : { model: normalizeModelIdentity(options.model) }),
  });
}

function createModelResolver(options, report) {
  if (options.model !== undefined) return () => options.model;
  if (options.resolveModel !== undefined) {
    return (context) => {
      const resolved = safely(
        () => Reflect.apply(options.resolveModel, undefined, [Object.freeze(context)]),
        report,
        "model.resolve",
      );
      if (resolved === undefined || resolved === null) return undefined;
      return safely(
        () => normalizeModelIdentity(resolved),
        report,
        "model.resolve",
      );
    };
  }
  return (context) => {
    if (context.providerHint === null || context.modelHint === null) return undefined;
    return safely(
      () => normalizeModelIdentity({
        provider: context.providerHint,
        model: context.modelHint,
      }),
      report,
      "model.resolve",
    );
  };
}

function normalizeModelIdentity(value) {
  const model = ownDataRecord(value, MODEL_KEYS, "cave_langgraph_model_invalid");
  if (typeof model.provider !== "string" || typeof model.model !== "string") {
    throw new Error("cave_langgraph_model_invalid");
  }
  const probe = defineModelUsage({
    schemaVersion: 1,
    provider: model.provider,
    model: model.model,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
    totalTokens: null,
    cost: { status: "unknown" },
  });
  return Object.freeze({ provider: probe.provider, model: probe.model });
}

function createStreamTransformer(onStreamEvent, report) {
  return Object.freeze({
    init() {
      return EMPTY_TRANSFORMER_PROJECTION;
    },
    process(event) {
      if (onStreamEvent !== undefined) {
        const snapshot = safely(
          () => deepFreeze(structuredClone(event)),
          report,
          "stream.snapshot",
        );
        if (snapshot !== undefined) {
          dispatch(onStreamEvent, snapshot, report, "stream.sink");
        }
      }
      return true;
    },
    fail(error) {
      if (error !== undefined) report("stream.source", error);
    },
  });
}

function usageFromMessage(message, modelIdentity) {
  const metadata = message?.usage_metadata;
  const inputTotal = token(metadata?.input_tokens);
  const outputTokens = token(metadata?.output_tokens);
  const totalTokens = token(metadata?.total_tokens);
  const inputDetails = metadata?.input_token_details;
  const outputDetails = metadata?.output_token_details;
  const hasRead = isObject(inputDetails) && Object.hasOwn(inputDetails, "cache_read");
  const hasWrite = isObject(inputDetails) && Object.hasOwn(inputDetails, "cache_creation");
  const cacheReadTokens = hasRead ? token(inputDetails.cache_read) : null;
  const cacheWriteTokens = hasWrite ? token(inputDetails.cache_creation) : null;
  const inputTokens = inputTotal !== null && cacheReadTokens !== null &&
      cacheWriteTokens !== null
    ? inputTotal - cacheReadTokens - cacheWriteTokens
    : null;
  const reasoningTokens = isObject(outputDetails) &&
      Object.hasOwn(outputDetails, "reasoning")
    ? token(outputDetails.reasoning)
    : null;
  return defineModelUsage({
    schemaVersion: 1,
    provider: modelIdentity.provider,
    model: modelIdentity.model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    totalTokens,
    cost: { status: "unknown" },
  });
}

function firstAIMessage(output) {
  try {
    if (!Array.isArray(output?.generations)) return undefined;
    for (const group of output.generations) {
      if (!Array.isArray(group)) continue;
      for (const generation of group) {
        if (AIMessage.isInstance(generation?.message)) return generation.message;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function modelIdentityFromMessage(message) {
  try {
    const provider = ownString(message?.response_metadata, "model_provider");
    const model = ownString(message?.response_metadata, "model_name");
    if (provider === null || model === null) return undefined;
    return normalizeModelIdentity({ provider, model });
  } catch {
    return undefined;
  }
}

function runIdentity(runId) {
  return defineAdapterLifecycleIdentity({
    runId,
    attempt: 1,
    replay: false,
    nativeIds: { langchainRunId: runId },
  });
}

function scopedIdentity(value, report) {
  return safely(
    () => defineAdapterLifecycleIdentity({
      runId: value.rootId,
      stepId: value.stepId,
      ...(value.modelCallId === undefined ? {} : { modelCallId: value.modelCallId }),
      ...(value.toolCallId === undefined ? {} : { toolCallId: value.toolCallId }),
      attempt: 1,
      replay: false,
      nativeIds: value.nativeIds,
    }),
    report,
    "lifecycle.identity",
  );
}

function serializedId(value) {
  try {
    if (!Array.isArray(value?.id) || value.id.some((part) => typeof part !== "string")) {
      return Object.freeze([]);
    }
    return Object.freeze([...value.id]);
  } catch {
    return Object.freeze([]);
  }
}

function ownString(value, key) {
  if (!isObject(value)) return null;
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    return null;
  }
  return descriptor !== undefined && "value" in descriptor &&
      typeof descriptor.value === "string"
    ? descriptor.value
    : null;
}

function token(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function isNativeId(value) {
  return typeof value === "string" && value.length > 0;
}

function isObject(value) {
  return value !== null && typeof value === "object";
}

function ownDataRecord(value, allowed, code) {
  if (!isObject(value) || Array.isArray(value)) throw new Error(code);
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new Error(code);
  }
  if (prototype !== Object.prototype && prototype !== null) throw new Error(code);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string" || !allowed.includes(key))) {
    throw new Error(code);
  }
  const output = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new Error(code);
    }
    output[key] = descriptor.value;
  }
  return output;
}

function createReporter(onObserverError) {
  return (stage, error) => {
    if (onObserverError === undefined) return;
    try {
      const result = Reflect.apply(onObserverError, undefined, [
        Object.freeze({ stage, error }),
      ]);
      if (result !== undefined) void Promise.resolve(result).catch(() => {});
    } catch {
      // Observation diagnostics never alter native execution.
    }
  };
}

function dispatch(sink, value, report, stage) {
  if (sink === undefined) return;
  try {
    const result = Reflect.apply(sink, undefined, [value]);
    if (result !== undefined) {
      void Promise.resolve(result).catch((error) => report(stage, error));
    }
  } catch (error) {
    report(stage, error);
  }
}

function safely(operation, report, stage) {
  try {
    return operation();
  } catch (error) {
    report(stage, error);
    return undefined;
  }
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

const adapterPackage = defineAdapterPackage({
  manifest: adapterManifest,
  createAdapter: createLangGraphAdapter,
});

export const manifest = adapterPackage.manifest;
export const createAdapter = adapterPackage.createAdapter;
export default adapterPackage;
