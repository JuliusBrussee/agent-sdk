import type { Processor } from "@mastra/core/processors";
import { createModelBoundary } from "@caveman-ai/agent/model-boundary";
import type { ModelUsage } from "@caveman-ai/agent/model-usage";
import {
  createMastraAdapter,
  normalizeMastraUsage,
  type MastraModelRequest,
  type MastraModelResponse,
} from "../src/index.js";

const boundary = createModelBoundary<MastraModelRequest, MastraModelResponse>([]);
const processor: Processor = createMastraAdapter({
  modelBoundary: boundary,
  onModelUsage(observation) {
    observation.usage satisfies ModelUsage;
    observation.identity.modelCallId satisfies string | undefined;
  },
});

void processor;
normalizeMastraUsage({
  inputTokens: 2,
  outputTokens: 1,
  totalTokens: 3,
}, { provider: "test", model: "model" }) satisfies ModelUsage;
