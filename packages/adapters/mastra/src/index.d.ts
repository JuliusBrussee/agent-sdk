import type {
  AdapterLifecycleEvent,
  AdapterLifecycleIdentity,
  AdapterManifestV2,
  AdapterPackage,
} from "@caveman-ai/adapter-kit";
import type { ModelBoundary } from "@caveman-ai/agent/model-boundary";
import type { ModelUsage } from "@caveman-ai/agent/model-usage";
import type {
  ProcessAPIErrorArgs,
  ProcessLLMRequestArgs,
  ProcessLLMRequestResult,
  ProcessLLMResponseArgs,
  ProcessOutputResultArgs,
  ProcessOutputStepArgs,
  ProcessOutputStreamArgs,
  Processor,
  ProcessorMessageResult,
} from "@mastra/core/processors";
import type { ChunkType } from "@mastra/core/stream";

export interface MastraModelIdentity {
  readonly provider: string;
  readonly model: string;
}

export type MastraModelRequest = ProcessLLMRequestArgs["prompt"];

export interface MastraModelResponse {
  readonly chunks: ProcessLLMResponseArgs["chunks"];
  readonly warnings: ProcessLLMResponseArgs["warnings"];
  readonly request: ProcessLLMResponseArgs["request"];
  readonly rawResponse: ProcessLLMResponseArgs["rawResponse"];
  readonly fromCache: false;
  readonly model: ProcessLLMResponseArgs["model"];
  readonly stepNumber: number;
}

export interface MastraUsageObservation {
  readonly usage: ModelUsage;
  readonly identity: AdapterLifecycleIdentity;
}

export interface MastraObserverError {
  readonly stage: string;
  readonly error: unknown;
}

export interface MastraAdapterOptions {
  /** Optional static identity. Native model.provider/modelId are used by default. */
  readonly model?: MastraModelIdentity;
  readonly modelBoundary?: ModelBoundary<MastraModelRequest, MastraModelResponse>;
  readonly onLifecycle?: (
    event: AdapterLifecycleEvent,
  ) => void | PromiseLike<void>;
  readonly onModelUsage?: (
    observation: MastraUsageObservation,
  ) => void | PromiseLike<void>;
  readonly onObserverError?: (
    error: MastraObserverError,
  ) => void | PromiseLike<void>;
}

export interface MastraAdapterProcessor extends Processor<"caveman-agent-sdk"> {
  readonly id: "caveman-agent-sdk";
  readonly name: "Caveman Agent SDK";
  processLLMRequest(args: ProcessLLMRequestArgs): Promise<ProcessLLMRequestResult>;
  processLLMResponse(args: ProcessLLMResponseArgs): void;
  processOutputStream(args: ProcessOutputStreamArgs): Promise<ChunkType>;
  processOutputStep(args: ProcessOutputStepArgs): ProcessorMessageResult;
  processOutputResult(args: ProcessOutputResultArgs): ProcessorMessageResult;
  processAPIError(args: ProcessAPIErrorArgs): void;
}

export const manifest: AdapterManifestV2;
export function createMastraAdapter(options?: MastraAdapterOptions): MastraAdapterProcessor;
export { createMastraAdapter as createAdapter };
export function normalizeMastraUsage(
  usage: ProcessOutputStepArgs["usage"],
  identity: MastraModelIdentity,
): ModelUsage;

declare const adapterPackage: AdapterPackage<typeof createMastraAdapter>;
export default adapterPackage;
