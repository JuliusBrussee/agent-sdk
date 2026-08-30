import type {
  AdapterLifecycleEvent,
  AdapterLifecycleIdentity,
  AdapterManifestV2,
  AdapterPackage,
} from "@caveman-ai/adapter-kit";
import type {
  ModelBoundary,
  ModelBoundaryRole,
} from "@caveman-ai/agent/model-boundary";
import type { ModelUsage } from "@caveman-ai/agent/model-usage";
import type {
  InvokeModelContext,
  InvokeModelResult,
  Model,
  Plugin,
  SystemPrompt,
  ToolChoice,
  ToolSpec,
  Message,
  Usage,
} from "@strands-agents/sdk";

export interface StrandsModelIdentity {
  readonly provider: string;
  readonly model: string;
}

export interface StrandsModelResolutionContext {
  readonly model: Model;
  readonly modelId: string | null;
}

export interface StrandsModelRequest {
  readonly messages: readonly Message[];
  readonly systemPrompt?: SystemPrompt;
  readonly toolSpecs: readonly ToolSpec[];
  readonly toolChoice?: ToolChoice;
  readonly projectedInputTokens?: number;
  readonly dynamicTrailingBlocks?: number;
}

export interface StrandsModelUsageObservation {
  readonly usage: ModelUsage;
  readonly identity: AdapterLifecycleIdentity;
}

export interface StrandsObserverError {
  readonly stage: string;
  readonly error: unknown;
}

export type StrandsLifecycleSink = (
  event: AdapterLifecycleEvent,
) => void | PromiseLike<void>;
export type StrandsModelUsageSink = (
  observation: StrandsModelUsageObservation,
) => void | PromiseLike<void>;
export type StrandsObserverErrorSink = (
  error: StrandsObserverError,
) => void | PromiseLike<void>;
export type StrandsModelResolver = (
  context: StrandsModelResolutionContext,
) => StrandsModelIdentity | null | undefined;

export interface StrandsAgentsAdapterOptions {
  /** Static identity for a single-model agent. Mutually exclusive with `resolveModel`. */
  readonly model?: StrandsModelIdentity;
  /** Resolve the concrete model selected by Strands routing for each native call. */
  readonly resolveModel?: StrandsModelResolver;
  readonly modelBoundary?: ModelBoundary<
    StrandsModelRequest,
    InvokeModelResult["result"]
  >;
  readonly role?: ModelBoundaryRole;
  readonly onLifecycle?: StrandsLifecycleSink;
  readonly onModelUsage?: StrandsModelUsageSink;
  readonly onObserverError?: StrandsObserverErrorSink;
}

export const STRANDS_AGENTS_VERSION: "1.15.0";
export function normalizeStrandsUsage(
  usage: Usage | null | undefined,
  identity: StrandsModelIdentity,
): ModelUsage;
export function createStrandsAgentsAdapter(
  options?: StrandsAgentsAdapterOptions,
): Plugin;

export const manifest: AdapterManifestV2;
export { createStrandsAgentsAdapter as createAdapter };
declare const adapterPackage: AdapterPackage<typeof createStrandsAgentsAdapter>;
export default adapterPackage;
