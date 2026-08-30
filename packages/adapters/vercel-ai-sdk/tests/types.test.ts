import type { LanguageModelMiddleware, ToolLoopAgentSettings } from "ai";
import { createModelBoundary } from "@caveman-ai/agent/model-boundary";
import type { ModelUsage } from "@caveman-ai/agent/model-usage";
import {
  createVercelAISDKAdapter,
  type VercelAgentCallbacks,
  type VercelModelRequest,
  type VercelModelResponse,
} from "@caveman-ai/adapter-vercel-ai-sdk";

const boundary = createModelBoundary<VercelModelRequest, VercelModelResponse>([]);
const adapter = createVercelAISDKAdapter({
  modelBoundary: boundary,
  onModelUsage(usage: ModelUsage) {
    void usage.totalTokens;
  },
});

const middleware: LanguageModelMiddleware = adapter.middleware;
void middleware;

const existing: VercelAgentCallbacks = {
  onStart: async event => {
    void event.callId;
  },
};
const callbacks = adapter.composeAgentCallbacks(existing);
const settingsCallbacks: Pick<
  ToolLoopAgentSettings,
  | "onStart"
  | "onStepStart"
  | "onToolExecutionStart"
  | "onToolExecutionEnd"
  | "onStepEnd"
  | "onEnd"
> = callbacks;
void settingsCallbacks;
