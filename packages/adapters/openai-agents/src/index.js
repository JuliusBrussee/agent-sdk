import {
  defineAdapterLifecycleIdentity,
  defineAdapterPackage,
} from "@caveman-ai/adapter-kit";
import { defineModelUsage } from "@caveman-ai/agent/model-usage";
import { adapterManifest } from "./manifest.js";

const OPTION_KEYS = new Set([
  "defaultModel",
  "modelBoundary",
  "onModelUsage",
  "onObserverError",
  "provider",
  "role",
]);
const NEVER_ABORT_SIGNAL = new AbortController().signal;
const PROVIDER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_MODEL_BYTES = 1_024;
const MAX_NATIVE_ID_LENGTH = 4_096;

export const OPENAI_AGENTS_VERSION = "0.17.0";
export const OPENAI_AGENTS_CORE_VERSION = "0.17.0";

/**
 * Wrap one native OpenAI Agents SDK ModelProvider. OpenAI Agents keeps
 * ownership of its runner, retries, tracing, tools, aborts, and stream.
 */
export function createOpenAIAgentsAdapter(provider, options = {}) {
  const normalized = normalizeOptions(options);
  const getModel = captureRequiredMethod(
    provider,
    "getModel",
    "cave_openai_agents_adapter_provider_invalid",
  );
  let nextScope = 0;

  const allocate = (kind) => {
    if (nextScope >= Number.MAX_SAFE_INTEGER) {
      throw new Error("cave_openai_agents_adapter_identity_exhausted");
    }
    nextScope += 1;
    return `openai-${kind}-${nextScope}`;
  };

  return Object.freeze({
    getModel(modelName) {
      const resolvedModelName = resolveModelName(modelName, normalized.defaultModel);
      const nativeResult = Reflect.apply(getModel, provider, [modelName]);
      return Promise.resolve(nativeResult).then((model) => wrapModel({
        model,
        modelName: resolvedModelName,
        normalized,
        allocate,
      }));
    },
  });
}

function wrapModel({ model, modelName, normalized, allocate }) {
  const getResponse = captureRequiredMethod(
    model,
    "getResponse",
    "cave_openai_agents_adapter_model_invalid",
  );
  const getStreamedResponse = captureRequiredMethod(
    model,
    "getStreamedResponse",
    "cave_openai_agents_adapter_model_invalid",
  );
  const getRetryAdvice = captureOptionalMethod(
    model,
    "getRetryAdvice",
    "cave_openai_agents_adapter_model_invalid",
  );

  const createCall = async (request) => {
    const identity = createIdentity(allocate, modelName);
    const preparedRequest = withRawUsage(request);
    if (normalized.modelBoundary === undefined) {
      return Object.freeze({
        request: preparedRequest,
        identity,
        terminal: undefined,
      });
    }
    if (modelName === undefined) {
      throw new Error("cave_openai_agents_adapter_model_identity_unknown");
    }
    const signal = requestSignal(preparedRequest);
    const context = Object.freeze({
      identity,
      role: normalized.role,
      provider: normalized.provider,
      model: modelName,
      signal,
    });
    const boundaryCall = await Reflect.apply(
      normalized.modelBoundary.prepare,
      normalized.modelBoundary.receiver,
      [preparedRequest, context],
    );
    const terminal = captureBoundaryCall(boundaryCall);
    try {
      requireRawUsage(terminal.request);
    } catch (error) {
      failBoundary(terminal, error);
      throw error;
    }
    return Object.freeze({
      request: terminal.request,
      identity,
      terminal,
    });
  };

  const observeResponse = (call, response) => {
    observeUsage(response, modelName, call.identity, normalized);
    settleBoundary(call.terminal, response);
  };

  const observeFailure = (call, error) => {
    failBoundary(call?.terminal, error);
  };

  const wrapped = {
    async getResponse(request) {
      const call = await createCall(request);
      try {
        const response = await Reflect.apply(getResponse, model, [call.request]);
        observeResponse(call, response);
        return response;
      } catch (error) {
        observeFailure(call, error);
        throw error;
      }
    },
    getStreamedResponse(request) {
      return createLazyStream({
        request,
        createCall,
        getStreamedResponse,
        model,
        modelName,
        normalized,
      });
    },
  };
  if (getRetryAdvice !== undefined) {
    wrapped.getRetryAdvice = function passthroughRetryAdvice(args) {
      return Reflect.apply(getRetryAdvice, model, [args]);
    };
  }
  return Object.freeze(wrapped);
}

function createLazyStream({
  request,
  createCall,
  getStreamedResponse,
  model,
  modelName,
  normalized,
}) {
  let statePromise;
  let terminal = false;
  let started = false;

  const start = () => {
    if (statePromise !== undefined) return statePromise;
    started = true;
    statePromise = createCall(request).then((call) => {
      let iterable;
      try {
        iterable = Reflect.apply(getStreamedResponse, model, [call.request]);
      } catch (error) {
        failBoundary(call.terminal, error);
        throw error;
      }
      let iteratorMethod;
      try {
        iteratorMethod = Reflect.get(iterable, Symbol.asyncIterator, iterable);
      } catch (error) {
        failBoundary(call.terminal, error);
        throw error;
      }
      if (typeof iteratorMethod !== "function") {
        const error = new Error("cave_openai_agents_adapter_stream_invalid");
        failBoundary(call.terminal, error);
        throw error;
      }
      let iterator;
      try {
        iterator = Reflect.apply(iteratorMethod, iterable, []);
      } catch (error) {
        failBoundary(call.terminal, error);
        throw error;
      }
      let methods;
      try {
        methods = captureIterator(iterator);
      } catch (error) {
        failBoundary(call.terminal, error);
        throw error;
      }
      return Object.freeze({ call, iterator, methods });
    });
    return statePromise;
  };

  const closeUnterminated = (state) => {
    if (terminal) return;
    terminal = true;
    failBoundary(
      state?.call.terminal,
      new Error("cave_openai_agents_adapter_model_stream_closed"),
    );
  };

  const inspect = (state, result) => {
    if (terminal || !isObject(result)) return;
    try {
      if (ownDataOptional(result, "done", "stream_result") === true) {
        // A stream that ends without response_done still ends. Leaving the
        // prepared call open would leak its boundary state for the process
        // lifetime, since terminality is one-shot.
        closeUnterminated(state);
        return;
      }
      const response = terminalResponse(
        ownDataOptional(result, "value", "stream_result"),
      );
      if (response === undefined) return;
      terminal = true;
      observeUsage(response, modelName, state.call.identity, normalized);
      settleBoundary(state.call.terminal, response);
    } catch (error) {
      reportObserverError(normalized, "stream.inspect", error);
    }
  };

  const fail = (state, error) => {
    if (!terminal) {
      terminal = true;
      failBoundary(state?.call.terminal, error);
    }
  };

  const iterator = {
    async next(value) {
      let state;
      try {
        state = await start();
        const result = await Reflect.apply(state.methods.next, state.iterator, [value]);
        inspect(state, result);
        return result;
      } catch (error) {
        fail(state, error);
        throw error;
      }
    },
    async return(value) {
      if (!started) return { done: true, value };
      let state;
      try {
        state = await start();
        // A consumer that breaks out of the loop abandons the call; the
        // boundary must be closed either way.
        if (state.methods.return === undefined) {
          closeUnterminated(state);
          return { done: true, value };
        }
        const result = await Reflect.apply(state.methods.return, state.iterator, [value]);
        inspect(state, result);
        closeUnterminated(state);
        return result;
      } catch (error) {
        fail(state, error);
        throw error;
      }
    },
    async throw(error) {
      if (!started) throw error;
      let state;
      try {
        state = await start();
      } catch (caught) {
        fail(state, caught);
        throw caught;
      }
      if (state.methods.throw === undefined) throw error;
      try {
        const result = await Reflect.apply(state.methods.throw, state.iterator, [error]);
        inspect(state, result);
        return result;
      } catch (caught) {
        fail(state, caught);
        throw caught;
      }
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  return Object.freeze(iterator);
}

function captureIterator(iterator) {
  if (!isObject(iterator)) {
    throw new Error("cave_openai_agents_adapter_stream_invalid");
  }
  return Object.freeze({
    next: captureRequiredMethod(
      iterator,
      "next",
      "cave_openai_agents_adapter_stream_invalid",
    ),
    return: captureOptionalMethod(
      iterator,
      "return",
      "cave_openai_agents_adapter_stream_invalid",
    ),
    throw: captureOptionalMethod(
      iterator,
      "throw",
      "cave_openai_agents_adapter_stream_invalid",
    ),
  });
}

function terminalResponse(event) {
  if (!isObject(event)) return undefined;
  const type = ownDataOptional(event, "type", "stream_event");
  if (type !== "response_done") return undefined;
  const response = ownDataOptional(event, "response", "stream_event");
  if (!isObject(response)) {
    throw new Error("cave_openai_agents_adapter_stream_terminal_invalid");
  }
  return response;
}

function createIdentity(allocate, modelName) {
  return defineAdapterLifecycleIdentity({
    runId: allocate("run"),
    stepId: allocate("step"),
    modelCallId: allocate("model"),
    attempt: 1,
    replay: false,
    nativeIds: modelName === undefined
      ? {}
      : { openaiModelName: modelName.slice(0, MAX_NATIVE_ID_LENGTH) },
  });
}

function withRawUsage(request) {
  if (!isObject(request) || Array.isArray(request)) {
    throw new Error("cave_openai_agents_adapter_request_invalid");
  }
  let requestDescriptors;
  let requestPrototype;
  try {
    requestDescriptors = Object.getOwnPropertyDescriptors(request);
    requestPrototype = Object.getPrototypeOf(request);
  } catch {
    throw new Error("cave_openai_agents_adapter_request_invalid");
  }
  const settingsDescriptor = requestDescriptors.modelSettings;
  if (settingsDescriptor === undefined || !("value" in settingsDescriptor) ||
      !isObject(settingsDescriptor.value) || Array.isArray(settingsDescriptor.value)) {
    throw new Error("cave_openai_agents_adapter_request_invalid");
  }
  let settingsDescriptors;
  let settingsPrototype;
  try {
    settingsDescriptors = Object.getOwnPropertyDescriptors(settingsDescriptor.value);
    settingsPrototype = Object.getPrototypeOf(settingsDescriptor.value);
  } catch {
    throw new Error("cave_openai_agents_adapter_request_invalid");
  }
  settingsDescriptors.preserveRawUsage = {
    value: true,
    writable: true,
    enumerable: true,
    configurable: true,
  };
  const modelSettings = Object.create(settingsPrototype, settingsDescriptors);
  requestDescriptors.modelSettings = { ...settingsDescriptor, value: modelSettings };
  return Object.create(requestPrototype, requestDescriptors);
}

function requireRawUsage(request) {
  if (!isObject(request) || Array.isArray(request)) {
    throw new Error("cave_openai_agents_adapter_boundary_request_invalid");
  }
  const modelSettings = ownDataOptional(request, "modelSettings", "boundary_request");
  if (!isObject(modelSettings) || Array.isArray(modelSettings) ||
      ownDataOptional(modelSettings, "preserveRawUsage", "boundary_request") !== true) {
    throw new Error("cave_openai_agents_adapter_boundary_raw_usage_disabled");
  }
}

function requestSignal(request) {
  const signal = ownDataOptional(request, "signal", "request");
  if (signal === undefined) return NEVER_ABORT_SIGNAL;
  if (!(signal instanceof AbortSignal)) {
    throw new Error("cave_openai_agents_adapter_request_signal_invalid");
  }
  return signal;
}

function captureBoundaryCall(value) {
  if (!isObject(value) || Array.isArray(value)) {
    throw new Error("cave_openai_agents_adapter_boundary_call_invalid");
  }
  let descriptors;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new Error("cave_openai_agents_adapter_boundary_call_invalid");
  }
  const request = descriptors.request;
  const settled = descriptors.settled;
  const failed = descriptors.failed;
  if (request === undefined || !("value" in request) ||
      settled === undefined || !("value" in settled) || typeof settled.value !== "function" ||
      failed === undefined || !("value" in failed) || typeof failed.value !== "function") {
    throw new Error("cave_openai_agents_adapter_boundary_call_invalid");
  }
  return Object.freeze({
    receiver: value,
    request: request.value,
    settled: settled.value,
    failed: failed.value,
  });
}

function settleBoundary(terminal, response) {
  if (terminal === undefined) return;
  observeBestEffort(() => Reflect.apply(terminal.settled, terminal.receiver, [response]));
}

function failBoundary(terminal, error) {
  if (terminal === undefined) return;
  observeBestEffort(() => Reflect.apply(terminal.failed, terminal.receiver, [error]));
}

function observeUsage(response, modelName, identity, normalized) {
  if (normalized.onModelUsage === undefined) return;
  if (modelName === undefined) {
    reportObserverError(
      normalized,
      "usage.identity",
      new Error("cave_openai_agents_adapter_model_identity_unknown"),
    );
    return;
  }
  let usage;
  try {
    const rawUsage = ownDataOptional(response, "rawUsage", "response");
    usage = normalizeOpenAIAgentsUsage(rawUsage, {
      provider: normalized.provider,
      model: modelName,
    });
  } catch (error) {
    reportObserverError(normalized, "usage.normalize", error);
    return;
  }
  const observation = Object.freeze({ usage, identity });
  observeBestEffort(
    () => normalized.onModelUsage(observation),
    (error) => reportObserverError(normalized, "usage.sink", error),
  );
}

export function normalizeOpenAIAgentsUsage(rawUsage, identity) {
  if (!isObject(identity) || Array.isArray(identity)) {
    throw new Error("cave_openai_agents_adapter_usage_identity_invalid");
  }
  const provider = ownDataRequired(identity, "provider", "usage_identity");
  const model = ownDataRequired(identity, "model", "usage_identity");
  if (!isProvider(provider) || !isModel(model)) {
    throw new Error("cave_openai_agents_adapter_usage_identity_invalid");
  }

  let totalInput = null;
  let outputTokens = null;
  let totalTokens = null;
  let cacheReadTokens = null;
  let reasoningTokens = null;
  if (rawUsage !== undefined && rawUsage !== null) {
    if (!isObject(rawUsage) || Array.isArray(rawUsage)) {
      throw new Error("cave_openai_agents_adapter_usage_invalid");
    }
    const responsesInput = count(rawUsage, "input_tokens");
    const chatInput = count(rawUsage, "prompt_tokens");
    const responsesOutput = count(rawUsage, "output_tokens");
    const chatOutput = count(rawUsage, "completion_tokens");
    assertExclusive(responsesInput, chatInput, "input_tokens");
    assertExclusive(responsesOutput, chatOutput, "output_tokens");
    totalInput = responsesInput ?? chatInput;
    outputTokens = responsesOutput ?? chatOutput;
    totalTokens = count(rawUsage, "total_tokens");

    const responsesInputDetails = ownDataOptional(
      rawUsage,
      "input_tokens_details",
      "usage",
    );
    const chatInputDetails = ownDataOptional(
      rawUsage,
      "prompt_tokens_details",
      "usage",
    );
    assertExclusive(responsesInputDetails, chatInputDetails, "input_token_details");
    const inputDetails = responsesInputDetails ?? chatInputDetails;
    if (inputDetails !== undefined && inputDetails !== null) {
      if (!isObject(inputDetails) || Array.isArray(inputDetails)) {
        throw new Error("cave_openai_agents_adapter_usage_invalid:input_token_details");
      }
      cacheReadTokens = count(inputDetails, "cached_tokens");
    }

    const responsesOutputDetails = ownDataOptional(
      rawUsage,
      "output_tokens_details",
      "usage",
    );
    const chatOutputDetails = ownDataOptional(
      rawUsage,
      "completion_tokens_details",
      "usage",
    );
    assertExclusive(responsesOutputDetails, chatOutputDetails, "output_token_details");
    const outputDetails = responsesOutputDetails ?? chatOutputDetails;
    if (outputDetails !== undefined && outputDetails !== null) {
      if (!isObject(outputDetails) || Array.isArray(outputDetails)) {
        throw new Error("cave_openai_agents_adapter_usage_invalid:output_token_details");
      }
      reasoningTokens = count(outputDetails, "reasoning_tokens");
    }
  }

  const inputTokens = totalInput === null || cacheReadTokens === null
    ? null
    : totalInput - cacheReadTokens;
  if (inputTokens !== null && inputTokens < 0) {
    throw new Error("cave_openai_agents_adapter_usage_invalid:cached_tokens");
  }
  return defineModelUsage({
    schemaVersion: 1,
    provider,
    model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens: null,
    reasoningTokens,
    totalTokens,
    cost: { status: "unknown" },
  });
}

function count(value, key) {
  const candidate = ownDataOptional(value, key, "usage");
  if (candidate === undefined || candidate === null) return null;
  if (!Number.isSafeInteger(candidate) || candidate < 0) {
    throw new Error(`cave_openai_agents_adapter_usage_invalid:${key}`);
  }
  return candidate;
}

function assertExclusive(left, right, field) {
  if (left !== null && left !== undefined && right !== null && right !== undefined) {
    throw new Error(`cave_openai_agents_adapter_usage_ambiguous:${field}`);
  }
}

function normalizeOptions(value) {
  if (!isObject(value) || Array.isArray(value)) {
    throw new Error("cave_openai_agents_adapter_options_invalid");
  }
  let descriptors;
  let keys;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
    keys = Reflect.ownKeys(value);
  } catch {
    throw new Error("cave_openai_agents_adapter_options_invalid");
  }
  if (keys.some((key) => typeof key !== "string" || !OPTION_KEYS.has(key))) {
    throw new Error("cave_openai_agents_adapter_options_invalid");
  }
  for (const key of keys) {
    if (!("value" in descriptors[key])) {
      throw new Error("cave_openai_agents_adapter_options_invalid");
    }
  }
  const provider = descriptors.provider?.value ?? "openai";
  const defaultModel = descriptors.defaultModel?.value;
  const role = descriptors.role?.value ?? "working";
  const onModelUsage = descriptors.onModelUsage?.value;
  const onObserverError = descriptors.onObserverError?.value;
  if (!isProvider(provider) ||
      defaultModel !== undefined && !isModel(defaultModel) ||
      role !== "working" && role !== "compaction" ||
      onModelUsage !== undefined && typeof onModelUsage !== "function" ||
      onObserverError !== undefined && typeof onObserverError !== "function") {
    throw new Error("cave_openai_agents_adapter_options_invalid");
  }
  const modelBoundary = captureModelBoundary(descriptors.modelBoundary?.value);
  return Object.freeze({
    provider,
    defaultModel,
    role,
    modelBoundary,
    onModelUsage,
    onObserverError,
  });
}

function captureModelBoundary(value) {
  if (value === undefined) return undefined;
  if (!isObject(value) || Array.isArray(value)) {
    throw new Error("cave_openai_agents_adapter_model_boundary_invalid");
  }
  const prepare = captureRequiredMethod(
    value,
    "prepare",
    "cave_openai_agents_adapter_model_boundary_invalid",
  );
  return Object.freeze({ receiver: value, prepare });
}

function captureRequiredMethod(receiver, key, code) {
  if (!isObject(receiver) && typeof receiver !== "function") throw new Error(code);
  let method;
  try {
    method = Reflect.get(receiver, key, receiver);
  } catch {
    throw new Error(code);
  }
  if (typeof method !== "function") throw new Error(code);
  return method;
}

function captureOptionalMethod(receiver, key, code) {
  if (!isObject(receiver) && typeof receiver !== "function") throw new Error(code);
  let method;
  try {
    method = Reflect.get(receiver, key, receiver);
  } catch {
    throw new Error(code);
  }
  if (method === undefined) return undefined;
  if (typeof method !== "function") throw new Error(code);
  return method;
}

function ownDataRequired(value, key, kind) {
  const result = ownDataOptional(value, key, kind);
  if (result === undefined) {
    throw new Error(`cave_openai_agents_adapter_${kind}_invalid`);
  }
  return result;
}

function ownDataOptional(value, key, kind) {
  if (!isObject(value)) throw new Error(`cave_openai_agents_adapter_${kind}_invalid`);
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    throw new Error(`cave_openai_agents_adapter_${kind}_invalid`);
  }
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor)) {
    throw new Error(`cave_openai_agents_adapter_${kind}_invalid`);
  }
  return descriptor.value;
}

function resolveModelName(value, fallback) {
  if (value === undefined) return fallback;
  if (!isModel(value)) {
    throw new Error("cave_openai_agents_adapter_model_identity_invalid");
  }
  return value;
}

function reportObserverError(normalized, source, error) {
  if (normalized.onObserverError === undefined) return;
  observeBestEffort(() => normalized.onObserverError(Object.freeze({ source, error })));
}

function observeBestEffort(observe, rejected) {
  try {
    void Promise.resolve(observe()).then(
      () => undefined,
      (error) => {
        try {
          rejected?.(error);
        } catch {
          // Observer reporting cannot control native execution.
        }
      },
    );
  } catch (error) {
    try {
      rejected?.(error);
    } catch {
      // Observer reporting cannot control native execution.
    }
  }
}

function isProvider(value) {
  return typeof value === "string" && PROVIDER.test(value);
}

function isModel(value) {
  return typeof value === "string" && value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_MODEL_BYTES && !/[\0\r\n]/u.test(value);
}

function isObject(value) {
  return value !== null && typeof value === "object";
}

const adapterPackage = defineAdapterPackage({
  manifest: adapterManifest,
  createAdapter: createOpenAIAgentsAdapter,
});

export const manifest = adapterPackage.manifest;
export const createAdapter = adapterPackage.createAdapter;
export default adapterPackage;
