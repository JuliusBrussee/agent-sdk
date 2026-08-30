import type {
  AdapterLifecycleEvent,
  AdapterManifestV2,
  AdapterPackage,
} from "@caveman-ai/adapter-kit";
import type {
  ModelBoundary,
  ModelBoundaryRole,
} from "@caveman-ai/agent/model-boundary";
import type { ModelUsage } from "@caveman-ai/agent/model-usage";
import type {
  GenerateTextOnEndCallback,
  GenerateTextOnStartCallback,
  GenerateTextOnStepEndCallback,
  GenerateTextOnStepStartCallback,
  LanguageModelMiddleware,
  LanguageModelUsage,
  OnToolExecutionEndCallback,
  OnToolExecutionStartCallback,
} from "ai";

type TransformParams = NonNullable<LanguageModelMiddleware["transformParams"]>;
type WrapGenerate = NonNullable<LanguageModelMiddleware["wrapGenerate"]>;
type WrapStream = NonNullable<LanguageModelMiddleware["wrapStream"]>;

export type VercelModelRequest = Parameters<TransformParams>[0]["params"];
export type VercelGenerateResult = Awaited<ReturnType<WrapGenerate>>;
export type VercelStreamResult = Awaited<ReturnType<WrapStream>>;
export type VercelModelResponse = VercelGenerateResult | VercelStreamResult;
export type VercelProviderUsage = VercelGenerateResult["usage"];

export interface VercelAgentCallbacks {
  readonly onStart?: GenerateTextOnStartCallback;
  readonly onStepStart?: GenerateTextOnStepStartCallback;
  readonly onToolExecutionStart?: OnToolExecutionStartCallback;
  readonly onToolExecutionEnd?: OnToolExecutionEndCallback;
  readonly onStepEnd?: GenerateTextOnStepEndCallback;
  readonly onEnd?: GenerateTextOnEndCallback;
}

type NativeCallback = (event: any) => void | PromiseLike<void>;
export type VercelAgentCallbackInput = Partial<
  Record<keyof VercelAgentCallbacks, NativeCallback>
>;

export interface VercelAISDKAdapterOptions {
  /** Canonical Caveman request boundary. Provider I/O remains Vercel-owned. */
  readonly modelBoundary?: ModelBoundary<VercelModelRequest, VercelModelResponse>;
  /** Diagnostic-only observer. Rejection never changes native execution. */
  readonly onLifecycleEvent?: (
    event: AdapterLifecycleEvent,
  ) => void | PromiseLike<void>;
  /** Diagnostic-only canonical usage observer. */
  readonly onModelUsage?: (usage: ModelUsage) => void | PromiseLike<void>;
  readonly role?: ModelBoundaryRole;
}

export interface VercelAISDKAdapter {
  readonly middleware: LanguageModelMiddleware;
  composeAgentCallbacks<Existing extends VercelAgentCallbackInput = VercelAgentCallbackInput>(
    existing?: Existing,
  ): VercelAgentCallbacks;
}

export const VERCEL_AI_SDK_VERSION: "7.0.84";
export const manifest: AdapterManifestV2;
export function createVercelAISDKAdapter(
  options?: VercelAISDKAdapterOptions,
): VercelAISDKAdapter;
export const createAdapter: typeof createVercelAISDKAdapter;

export function normalizeVercelUsage(
  usage: VercelProviderUsage | LanguageModelUsage,
  identity: Readonly<{ provider: string; model: string }>,
): ModelUsage;

declare const adapterPackage: AdapterPackage<typeof createVercelAISDKAdapter>;
export default adapterPackage;
