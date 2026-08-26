// TS port of public/cacheengine/types.go (Agent SDK v2 phase 2, issue #217).
// The Go engine is the source of truth: planner-fixtures/{planner,wire}.json
// pin parity byte-for-byte, and a TS/Go disagreement is a TS bug — never a
// fixture hand-edit. Contract preserved from the Go package: original bytes on
// every uncertain path, provider-native hints only, no verified-dollar minting
// (`claimBasis` is at most "inferred"; `verifiedSavingsUsd` is always zero).

/** Provider cache-control semantics without naming a provider. */
export type CacheMode = "unsupported" | "implicit" | "affinity" | "explicit";

/** What one provider-confirmed cache hit proves. "" mirrors Go's zero value. */
export type CacheAttribution = "" | "none" | "organic" | "affinity" | "causal";

/** Engine action for one plan or provider-native request. */
export type CacheDecision = "apply" | "observe_only" | "pass_through" | "new_epoch";

export const ReasonApplied = "applied";
export const ReasonProviderManaged = "provider_managed";
export const ReasonUnsupported = "unsupported";
export const ReasonRecordMode = "record_mode";
export const ReasonNonPAYG = "non_payg";
export const ReasonMalformedRequest = "malformed_request";
export const ReasonCallerManaged = "caller_managed";
export const ReasonProfileMismatch = "profile_mismatch";
export const ReasonNoStablePrefix = "no_stable_prefix";
export const ReasonVolatilePrefix = "volatile_prefix";
export const ReasonPrefixDrift = "prefix_drift";
export const ReasonBelowMinimum = "below_minimum";
export const ReasonNoExpectedReuse = "no_expected_reuse";
export const ReasonNegativeEconomics = "negative_economics";
export const ReasonTransformUnavailable = "transform_unavailable";
export const ReasonAffinityFallback = "affinity_fallback";

export const AnthropicStableOptimizerID = "anthropic-cache-breakpoints";
export const AnthropicRollingOptimizerID = "cave-cache-anthropic-rolling-v1";
export const OpenAIKeyOptimizerID = "openai-prompt-cache-key";
export const OpenAIExplicitOptimizerID = "cave-cache-openai-explicit-v1";
export const BedrockCacheOptimizerID = "bedrock-cache-points";
export const BedrockRollingOptimizerID = "cave-cache-bedrock-rolling-v1";

/** Capability data consumed by the planner (Go `Profile`, TTL in seconds). */
export interface CachePlanProfile {
  id: string;
  provider?: string;
  mode: CacheMode;
  attribution: CacheAttribution;
  minPrefixTokens: number;
  maxBreakpoints: number;
  economicsKnown: boolean;
  writeMultiplier: number;
  readMultiplier: number;
  ttlSeconds: number;
  rolling: boolean;
  routingKey: boolean;
  maxRpmPerKey: number;
  optimizerId: string;
}

/** Partial profile input; the engine normalizes exactly like Go does. */
export type CachePlanProfileInput =
  Partial<CachePlanProfile> & Pick<CachePlanProfile, "id" | "mode">;

/**
 * One ordered prompt-prefix component. `stable` is caller-owned truth: content
 * that may change inside an epoch must never be labelled stable.
 */
export interface CachePlanSegment {
  name: string;
  content: string | Uint8Array;
  tokens?: number;
  stable?: boolean;
  cacheable?: boolean;
  /** Total calls expected to share this prefix while warm; 0 inherits the request's. */
  expectedCalls?: number;
}

export interface CachePlanRequest {
  scope: string;
  epoch: string;
  partitionKey?: string;
  expectedRequestsPerMinute?: number;
  /** Total calls expected to share the prefix within profile TTL; 0 = conservative. */
  expectedCalls?: number;
  profile: CachePlanProfileInput;
  segments: readonly CachePlanSegment[];
}

/**
 * Plan wire shape (snake_case): identical to the Go `Plan` struct's own JSON,
 * which is exactly what the parity fixtures pin. Units are input-rate units —
 * one unit is one token billed at full input rate — never dollars.
 */
export interface CacheBreakpoint {
  after_segment: string;
  prefix_sha256: string;
  prefix_tokens: number;
  expected_calls: number;
  break_even_calls: number;
  expected_net_input_rate_units: number;
}

export interface CachePlan {
  decision: CacheDecision;
  reason: string;
  profile_id: string;
  mode: CacheMode;
  attribution: CacheAttribution;
  prefix_sha256?: string;
  routing_key?: string;
  key_shard: number;
  key_shard_count: number;
  breakpoints?: CacheBreakpoint[];
  expected_net_input_rate_units: number;
  economics_basis: string;
  warnings?: string[];
}

/** One provider request plus cache-planning context (Go `NativeRequest`). */
export interface NativeCacheRequest {
  scope: string;
  epoch: string;
  partitionKey?: string;
  expectedRequestsPerMinute?: number;
  expectedCalls?: number;
  provider: string;
  model?: string;
  region?: string;
  endpoint?: string;
  body: string;
  runtimeMode?: string;
  authMode?: string;
  /**
   * Should come from provider counting when available. Zero keeps
   * transformation possible but makes threshold/economics eligibility unknown.
   */
  prefixTokens?: number;
}

/** Exact upstream body plus decision and attribution metadata. */
export interface NativeCacheResult {
  body: string;
  applied: boolean;
  decision: CacheDecision;
  reason: string;
  optimizerIds: string[];
  profile: CachePlanProfile;
  plan: CachePlan;
  /** "inferred" at most — this planner never mints verified dollars. */
  claimBasis: "none" | "inferred";
  /** Always zero here; managed gateway accounting owns any stronger claim. */
  verifiedSavingsUsd: 0;
}

/** Engine resource limits (Go `Config`, minus custom driver/resolver seams). */
export interface CacheEngineConfig {
  /** Bounds automatic affinity-key partitioning. Zero uses 64. */
  maxKeyShards?: number;
  /** Bounds provider-native request bodies. Zero uses 64 MiB. */
  maxRequestBytes?: number;
  /** Bounds framed stable-prefix bytes. Zero uses 64 MiB. */
  maxStablePrefixBytes?: number;
}
