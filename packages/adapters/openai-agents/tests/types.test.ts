import type { ModelProvider, ModelRequest } from "@openai/agents";
import { ScriptedModel } from "@openai/agents/testing";
import { createModelBoundary } from "@caveman-ai/agent/model-boundary";
import type { ModelUsage } from "@caveman-ai/agent/model-usage";
import {
  createOpenAIAgentsAdapter,
  type OpenAIAgentsModelResponse,
  type OpenAIAgentsUsageObservation,
} from "@caveman-ai/adapter-openai-agents";

const nativeProvider: ModelProvider = {
  getModel() {
    return new ScriptedModel();
  },
};
const boundary = createModelBoundary<ModelRequest, OpenAIAgentsModelResponse>([]);
const wrapped: ModelProvider = createOpenAIAgentsAdapter(nativeProvider, {
  provider: "openai",
  defaultModel: "gpt-5-mini",
  modelBoundary: boundary,
  onModelUsage(observation: OpenAIAgentsUsageObservation) {
    const usage: ModelUsage = observation.usage;
    void usage.totalTokens;
    void observation.identity.modelCallId;
  },
  onObserverError({ source, error }) {
    void source;
    void error;
  },
});
void wrapped;
