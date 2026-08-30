import { performance } from "node:perf_hooks";
import { wrapLanguageModel } from "ai";
import { createModelBoundary } from "@caveman-ai/agent/model-boundary";
import { createVercelAISDKAdapter } from "../src/index.js";

const WARMUP = 5_000;
const SAMPLES = 50_000;
const HOOKS_PER_SAMPLE = 6;
const samples = [];
const adapter = createVercelAISDKAdapter({ onLifecycleEvent() {} });
const callbacks = adapter.composeAgentCallbacks();

for (let index = -WARMUP; index < SAMPLES; index++) {
  const callId = `bench-${index}`;
  const toolCall = {
    type: "tool-call",
    toolCallId: `tool-${index}`,
    toolName: "noop",
  };
  const started = performance.now();
  callbacks.onStart({ callId });
  callbacks.onStepStart({
    callId,
    stepNumber: 0,
    provider: "bench-provider",
    modelId: "bench-model",
  });
  callbacks.onToolExecutionStart({ callId, toolCall });
  callbacks.onToolExecutionEnd({
    callId,
    toolCall,
    toolOutput: { type: "tool-result" },
  });
  callbacks.onStepEnd({ callId, stepNumber: 0 });
  callbacks.onEnd({ callId });
  if (index >= 0) {
    samples.push((performance.now() - started) * 1_000 / HOOKS_PER_SAMPLE);
  }
}

samples.sort((left, right) => left - right);
const percentile = (value) => samples[Math.ceil(samples.length * value) - 1];
const modelSamples = [];
const nativeResult = {
  content: [],
  finishReason: { unified: "stop", raw: "stop" },
  usage: {
    inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 0, text: 0, reasoning: 0 },
  },
  warnings: [],
};
const nativeModel = {
  specificationVersion: "v4",
  provider: "bench-provider",
  modelId: "bench-model",
  supportedUrls: {},
  async doGenerate() { return nativeResult; },
  async doStream() { throw new Error("unused"); },
};
const modelAdapter = createVercelAISDKAdapter({
  modelBoundary: createModelBoundary([]),
});
const wrappedModel = wrapLanguageModel({
  model: nativeModel,
  middleware: modelAdapter.middleware,
});
for (let index = -WARMUP; index < SAMPLES; index++) {
  const started = performance.now();
  await wrappedModel.doGenerate({ prompt: [] });
  if (index >= 0) modelSamples.push((performance.now() - started) * 1_000);
}
modelSamples.sort((left, right) => left - right);
const modelPercentile = (value) =>
  modelSamples[Math.ceil(modelSamples.length * value) - 1];
const result = {
  node: process.version,
  samples: SAMPLES,
  hooksPerSample: HOOKS_PER_SAMPLE,
  lifecycleHookP50Microseconds: percentile(0.5),
  lifecycleHookP99Microseconds: percentile(0.99),
  modelBoundaryP50Microseconds: modelPercentile(0.5),
  modelBoundaryP99Microseconds: modelPercentile(0.99),
  thresholds: { p50Microseconds: 25, p99Microseconds: 100 },
};
console.log(JSON.stringify(result));
if (result.lifecycleHookP50Microseconds > result.thresholds.p50Microseconds ||
    result.lifecycleHookP99Microseconds > result.thresholds.p99Microseconds ||
    result.modelBoundaryP50Microseconds > result.thresholds.p50Microseconds ||
    result.modelBoundaryP99Microseconds > result.thresholds.p99Microseconds) {
  process.exitCode = 1;
}
