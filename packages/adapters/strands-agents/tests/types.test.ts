import { Agent, type InvokeModelResult, type Plugin } from "@strands-agents/sdk";
import { createModelBoundary } from "@caveman-ai/agent/model-boundary";
import {
  createStrandsAgentsAdapter,
  normalizeStrandsUsage,
  type StrandsModelRequest,
  type StrandsModelUsageObservation,
} from "../src/index.js";

const boundary = createModelBoundary<
  StrandsModelRequest,
  InvokeModelResult["result"]
>([{
  id: "types",
  prepare({ request, context }) {
    context.signal satisfies AbortSignal;
    return { ...request, dynamicTrailingBlocks: 1 };
  },
}]);

const plugin: Plugin = createStrandsAgentsAdapter({
  resolveModel({ model, modelId }) {
    model.modelId satisfies string | undefined;
    return modelId === null
      ? undefined
      : { provider: "test", model: modelId };
  },
  modelBoundary: boundary,
  onModelUsage(observation: StrandsModelUsageObservation) {
    observation.usage.totalTokens satisfies number | null;
  },
});

new Agent({ plugins: [plugin], printer: false });

normalizeStrandsUsage({
  inputTokens: 1,
  outputTokens: 1,
  totalTokens: 2,
  cacheReadInputTokens: 0,
  cacheWriteInputTokens: 0,
}, { provider: "test", model: "model" }).reasoningTokens satisfies number | null;
