import type {
  AdapterLifecycleEvent,
  AdapterLifecycleIdentity,
  AdapterManifestV2,
  AdapterPackage,
} from "@caveman-ai/adapter-kit";
import type { ModelUsage } from "@caveman-ai/agent/model-usage";
import type { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { Callbacks } from "@langchain/core/callbacks/manager";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { ProtocolEvent, StreamTransformer } from "@langchain/langgraph";

export interface LangGraphModelIdentity {
  readonly provider: string;
  readonly model: string;
}

export interface LangGraphModelContext {
  readonly nativeRunId: string;
  readonly parentRunId: string;
  readonly serializedId: readonly string[];
  readonly providerHint: string | null;
  readonly modelHint: string | null;
}

export interface LangGraphUsageObservation {
  readonly usage: ModelUsage;
  readonly identity: AdapterLifecycleIdentity;
}

export interface LangGraphObserverError {
  readonly stage: string;
  readonly error: unknown;
}

export type LangGraphLifecycleSink = (
  event: AdapterLifecycleEvent,
) => void | PromiseLike<void>;
export type LangGraphUsageSink = (
  observation: LangGraphUsageObservation,
) => void | PromiseLike<void>;
export type LangGraphStreamSink = (
  event: Readonly<ProtocolEvent>,
) => void | PromiseLike<void>;
export type LangGraphObserverErrorSink = (
  error: LangGraphObserverError,
) => void | PromiseLike<void>;
export type LangGraphModelResolver = (
  context: LangGraphModelContext,
) => LangGraphModelIdentity | null | undefined;
export type LangGraphStreamTransformerFactory = () => StreamTransformer<Readonly<Record<string, never>>>;

export interface LangGraphAdapterOptions {
  /** Static identity for single-model graphs. Mutually exclusive with `resolveModel`. */
  readonly model?: LangGraphModelIdentity;
  /** Per-call identity for multi-model graphs. Mutually exclusive with `model`. */
  readonly resolveModel?: LangGraphModelResolver;
  readonly onLifecycle?: LangGraphLifecycleSink;
  readonly onUsage?: LangGraphUsageSink;
  readonly onStreamEvent?: LangGraphStreamSink;
  readonly onObserverError?: LangGraphObserverErrorSink;
}

export interface LangGraphAdapter {
  readonly callbackHandler: BaseCallbackHandler;
  readonly callbacks: readonly [BaseCallbackHandler];
  readonly transformer: LangGraphStreamTransformerFactory;
  readonly transformers: readonly [LangGraphStreamTransformerFactory];
  composeCallbacks(existing?: Callbacks): Callbacks;
  composeConfig(): RunnableConfig & { readonly callbacks: Callbacks };
  composeConfig<TConfig extends RunnableConfig>(
    config: TConfig,
  ): TConfig & { readonly callbacks: Callbacks };
  composeTransformers(): readonly [LangGraphStreamTransformerFactory];
  composeTransformers<
    const TTransformers extends readonly (() => StreamTransformer<unknown>)[],
  >(
    existing: TTransformers,
  ): readonly [...TTransformers, LangGraphStreamTransformerFactory];
}

export const manifest: AdapterManifestV2;
export function createLangGraphAdapter(options?: LangGraphAdapterOptions): LangGraphAdapter;
export { createLangGraphAdapter as createAdapter };
declare const adapterPackage: AdapterPackage<typeof createLangGraphAdapter>;
export default adapterPackage;
