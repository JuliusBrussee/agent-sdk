import type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
  StreamEventResponseCompleted,
} from "@openai/agents";
import type {
  AdapterLifecycleIdentity,
  AdapterManifestV2,
  AdapterPackage,
} from "@caveman-ai/adapter-kit";
import type {
  ModelBoundary,
  ModelBoundaryRole,
} from "@caveman-ai/agent/model-boundary";
import type { ModelUsage } from "@caveman-ai/agent/model-usage";

export type OpenAIAgentsStreamResponse = StreamEventResponseCompleted["response"];
export type OpenAIAgentsModelResponse = ModelResponse | OpenAIAgentsStreamResponse;

export interface OpenAIAgentsUsageObservation {
  readonly usage: ModelUsage;
  readonly identity: AdapterLifecycleIdentity & { readonly modelCallId: string };
}

export interface OpenAIAgentsObserverError {
  readonly source:
    | "usage.identity"
    | "usage.normalize"
    | "usage.sink"
    | "stream.inspect";
  readonly error: unknown;
}

export interface OpenAIAgentsAdapterOptions {
  /** Canonical provider identity. Defaults to `openai`; override compatible providers. */
  readonly provider?: string;
  /** Required only when native `getModel()` is called without a model name. */
  readonly defaultModel?: string;
  /** Canonical Caveman request boundary. Provider I/O remains OpenAI Agents-owned. */
  readonly modelBoundary?: ModelBoundary<ModelRequest, OpenAIAgentsModelResponse>;
  /** Diagnostic-only exact raw-usage observation. */
  readonly onModelUsage?: (
    observation: OpenAIAgentsUsageObservation,
  ) => void | PromiseLike<void>;
  /** Diagnostic-only observer failure sink. */
  readonly onObserverError?: (
    error: OpenAIAgentsObserverError,
  ) => void | PromiseLike<void>;
  readonly role?: ModelBoundaryRole;
}

export const OPENAI_AGENTS_VERSION: "0.17.0";
export const OPENAI_AGENTS_CORE_VERSION: "0.17.0";
export const manifest: AdapterManifestV2;

export function createOpenAIAgentsAdapter(
  provider: ModelProvider,
  options?: OpenAIAgentsAdapterOptions,
): ModelProvider;
export const createAdapter: typeof createOpenAIAgentsAdapter;

export function normalizeOpenAIAgentsUsage(
  rawUsage: unknown,
  identity: Readonly<{ provider: string; model: string }>,
): ModelUsage;

declare const adapterPackage: AdapterPackage<typeof createOpenAIAgentsAdapter>;
export default adapterPackage;
