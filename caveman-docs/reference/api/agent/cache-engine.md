# `@caveman-ai/agent/cache-engine`

> Generated from the built type declarations by `node scripts/generate-docs-api.mjs`.
> Do not edit by hand. Version at generation time: `0.2.0`.

Declaration file: `packages/agent/dist/cache-planner/index.d.ts`.

<details><summary>Symbol index</summary>

- **Class**: `CacheEngine`, `CachePlanEngine`
- **Interface**: `CacheBreakpoint`, `CacheEngineConfig`, `CachePlan`, `CachePlanProfile`, `CachePlanRequest`, `CachePlanSegment`, `NativeCacheRequest`, `NativeCacheResult`, `PrefixBelowMinimumDiagnostic`, `PrefixShrinkDiagnostic`, `ProviderCachePerformance`, `ProviderCacheUsageSample`, `VolatilePrefixDiagnostic`
- **Type alias**: `CacheAttribution`, `CacheDecision`, `CacheMode`, `CachePlanProfileInput`, `StaticPlanFailure`
- **Function**: `analyzeProviderCachePerformance`, `detectVolatile`, `findVolatileFrozenSegment`, `frozenPrefixSegments`, `frozenPrefixTokens`, `optimizeNativeRequest`, `providerPrefixMinimum`, `renderBelowMinimumAdvisory`, `renderStaticPlanFailure`, `resolveAnthropicProfile`, `resolveBedrockProfile`, `resolveOpenAIProfile`, `withPerturbedClock`
- **Variable**: `AnthropicRollingOptimizerID`, `AnthropicStableOptimizerID`, `BedrockCacheOptimizerID`, `BedrockRollingOptimizerID`, `CODING_CACHE_INPUT_TOKEN_HIT_TARGET`, `OpenAIExplicitOptimizerID`, `OpenAIKeyOptimizerID`, `ReasonAffinityFallback`, `ReasonApplied`, `ReasonBelowMinimum`, `ReasonCallerManaged`, `ReasonMalformedRequest`, `ReasonNegativeEconomics`, `ReasonNoExpectedReuse`, `ReasonNonPAYG`, `ReasonNoStablePrefix`, `ReasonPrefixDrift`, `ReasonProfileMismatch`, `ReasonProviderManaged`, `ReasonRecordMode`, `ReasonTransformUnavailable`, `ReasonUnsupported`, `ReasonVolatilePrefix`, `VOLATILITY_CLOCK_SHIFT_MS`

</details>

## Classes

### `CacheEngine`

Cache-plan engine: stable-prefix frontier, break-even math, volatile/drift
guard, scoped affinity-key sharding. Byte limits fail closed; every
validation error throws rather than producing a guessed plan.

```ts
export declare class CachePlanEngine {
    private readonly maxKeyShards;
    readonly maxRequestBytes: number;
    private readonly maxStablePrefixBytes;
    /** epoch key -> frozen prefix sha256, insertion-ordered for eviction. */
    private readonly epochs;
    constructor(config?: CacheEngineConfig);
    /** Selects profitable stable-prefix cache boundaries without editing wire bytes. */
    plan(request: CachePlanRequest): CachePlan;
}
```

Declared in `packages/agent/dist/cache-planner/engine.d.ts`.

### `CachePlanEngine`

Cache-plan engine: stable-prefix frontier, break-even math, volatile/drift
guard, scoped affinity-key sharding. Byte limits fail closed; every
validation error throws rather than producing a guessed plan.

```ts
export declare class CachePlanEngine {
    private readonly maxKeyShards;
    readonly maxRequestBytes: number;
    private readonly maxStablePrefixBytes;
    /** epoch key -> frozen prefix sha256, insertion-ordered for eviction. */
    private readonly epochs;
    constructor(config?: CacheEngineConfig);
    /** Selects profitable stable-prefix cache boundaries without editing wire bytes. */
    plan(request: CachePlanRequest): CachePlan;
}
```

Declared in `packages/agent/dist/cache-planner/engine.d.ts`.

## Interfaces

### `CacheBreakpoint`

Plan wire shape (snake_case): identical to the Go `Plan` struct's own JSON,
which is exactly what the parity fixtures pin. Units are input-rate units —
one unit is one token billed at full input rate — never dollars.

```ts
export interface CacheBreakpoint {
    after_segment: string;
    prefix_sha256: string;
    prefix_tokens: number;
    expected_calls: number;
    break_even_calls: number;
    expected_net_input_rate_units: number;
}
```

Declared in `packages/agent/dist/cache-planner/types.d.ts`.

### `CacheEngineConfig`

Engine resource limits (Go `Config`, minus custom driver/resolver seams).

```ts
export interface CacheEngineConfig {
    /** Bounds automatic affinity-key partitioning. Zero uses 64. */
    maxKeyShards?: number;
    /** Bounds provider-native request bodies. Zero uses 64 MiB. */
    maxRequestBytes?: number;
    /** Bounds framed stable-prefix bytes. Zero uses 64 MiB. */
    maxStablePrefixBytes?: number;
}
```

Declared in `packages/agent/dist/cache-planner/types.d.ts`.

### `CachePlan`

```ts
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
```

Declared in `packages/agent/dist/cache-planner/types.d.ts`.

### `CachePlanProfile`

Capability data consumed by the planner (Go `Profile`, TTL in seconds).

```ts
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
```

Declared in `packages/agent/dist/cache-planner/types.d.ts`.

### `CachePlanRequest`

```ts
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
```

Declared in `packages/agent/dist/cache-planner/types.d.ts`.

### `CachePlanSegment`

One ordered prompt-prefix component. `stable` is caller-owned truth: content
that may change inside an epoch must never be labelled stable.

```ts
export interface CachePlanSegment {
    name: string;
    content: string | Uint8Array;
    tokens?: number;
    stable?: boolean;
    cacheable?: boolean;
    /** Total calls expected to share this prefix while warm; 0 inherits the request's. */
    expectedCalls?: number;
}
```

Declared in `packages/agent/dist/cache-planner/types.d.ts`.

### `NativeCacheRequest`

One provider request plus cache-planning context (Go `NativeRequest`).

```ts
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
```

Declared in `packages/agent/dist/cache-planner/types.d.ts`.

### `NativeCacheResult`

Exact upstream body plus decision and attribution metadata.

```ts
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
```

Declared in `packages/agent/dist/cache-planner/types.d.ts`.

### `PrefixBelowMinimumDiagnostic`

```ts
export interface PrefixBelowMinimumDiagnostic {
    code: "cave_frozen_prefix_below_provider_minimum";
    prefixTokens: number;
    minimumTokens: number;
    /** Bare model name (no provider prefix), as the provider names it. */
    model: string;
}
```

Declared in `packages/agent/dist/cache-planner/static-checks.d.ts`.

### `PrefixShrinkDiagnostic`

```ts
export interface PrefixShrinkDiagnostic {
    code: "cave_prefix_shrink_regression";
    lockedTokens: number;
    currentTokens: number;
}
```

Declared in `packages/agent/dist/cache-planner/static-checks.d.ts`.

### `ProviderCachePerformance`

```ts
export interface ProviderCachePerformance {
    basis: "provider_reported" | "unavailable";
    target: number;
    /** Uncached + cache-read + cache-write input. Output never enters this ratio. */
    providerInputTokens: number;
    uncachedInputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    /** Provider-reported input-token share served from cache; null without complete evidence. */
    cacheInputTokenHitRatio: number | null;
    targetMet: boolean | null;
}
```

Declared in `packages/agent/dist/cache-planner/performance.d.ts`.

### `ProviderCacheUsageSample`

```ts
export interface ProviderCacheUsageSample {
    /** Cache ratios exist only when every contributing call came from provider usage. */
    usageBasis: "provider_reported" | "unavailable";
    /** Provider-billed input that was neither a cache read nor cache creation. */
    inputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
}
```

Declared in `packages/agent/dist/cache-planner/performance.d.ts`.

### `VolatilePrefixDiagnostic`

```ts
export interface VolatilePrefixDiagnostic {
    code: "cave_frozen_prefix_volatile_segment";
    /** e.g. "agent.ts:8" from a fixture; the live check knows only "agent.ts". */
    location: string;
    segmentId: string;
    stability: string;
    /** Single-line source of the offending context value, when known. */
    sourcePreview?: string;
    /** Suggested tool filename for the fix (a suggestion, not an existing file). */
    fixToolPath: string;
}
```

Declared in `packages/agent/dist/cache-planner/static-checks.d.ts`.

## Type aliases

### `CacheAttribution`

What one provider-confirmed cache hit proves. "" mirrors Go's zero value.

```ts
export type CacheAttribution = "" | "none" | "organic" | "affinity" | "causal";
```

Declared in `packages/agent/dist/cache-planner/types.d.ts`.

### `CacheDecision`

Engine action for one plan or provider-native request.

```ts
export type CacheDecision = "apply" | "observe_only" | "pass_through" | "new_epoch";
```

Declared in `packages/agent/dist/cache-planner/types.d.ts`.

### `CacheMode`

Provider cache-control semantics without naming a provider.

```ts
export type CacheMode = "unsupported" | "implicit" | "affinity" | "explicit";
```

Declared in `packages/agent/dist/cache-planner/types.d.ts`.

### `CachePlanProfileInput`

Partial profile input; the engine normalizes exactly like Go does.

```ts
export type CachePlanProfileInput = Partial<CachePlanProfile> & Pick<CachePlanProfile, "id" | "mode">;
```

Declared in `packages/agent/dist/cache-planner/types.d.ts`.

### `StaticPlanFailure`

```ts
export type StaticPlanFailure = VolatilePrefixDiagnostic | PrefixShrinkDiagnostic | PrefixBelowMinimumDiagnostic;
```

Declared in `packages/agent/dist/cache-planner/static-checks.d.ts`.

## Functions

### `analyzeProviderCachePerformance`

Aggregate cache performance without inventing cache eligibility or hits.
One unavailable call makes ratio unavailable; mixed evidence is never averaged.

```ts
export declare function analyzeProviderCachePerformance(samples: readonly ProviderCacheUsageSample[], target?: number): ProviderCachePerformance;
```

Declared in `packages/agent/dist/cache-planner/performance.d.ts`.

### `detectVolatile`

True when the prefix bytes match a volatile pattern (timestamps, UUIDs, …).

```ts
export declare function detectVolatile(prefix: Uint8Array): boolean;
```

Declared in `packages/agent/dist/cache-planner/engine.d.ts`.

### `findVolatileFrozenSegment`

The #224 first half: two independent composition passes must lower to a
byte-identical frozen prefix. Returns the first frozen segment whose bytes
differ between the passes (or whose presence differs), else undefined.

```ts
export declare function findVolatileFrozenSegment(first: ContextIR, second: ContextIR): Pick<ContextSegment, "id" | "stability"> | undefined;
```

Declared in `packages/agent/dist/cache-planner/static-checks.d.ts`.

### `frozenPrefixSegments`

Frozen-prefix segments of a lowered Context IR, in order.

```ts
export declare function frozenPrefixSegments(ir: ContextIR): ContextSegment[];
```

Declared in `packages/agent/dist/cache-planner/static-checks.d.ts`.

### `frozenPrefixTokens`

Estimated token count of the frozen prefix (same estimate the IR carries).

```ts
export declare function frozenPrefixTokens(ir: ContextIR): number;
```

Declared in `packages/agent/dist/cache-planner/static-checks.d.ts`.

### `optimizeNativeRequest`

Applies provider-native cache metadata or returns the original body on every
unsupported or unsafe path. Makes no network call and mints nothing.

```ts
export declare function optimizeNativeRequest(engine: CachePlanEngine, request: NativeCacheRequest): NativeCacheResult;
```

Declared in `packages/agent/dist/cache-planner/wires.d.ts`.

### `providerPrefixMinimum`

Provider minimum cacheable prefix length for a "provider/model" id, from the
catalog's cache profiles. Unknown model or profile → undefined (the check
honestly cannot fire; unpriced-model handling lives elsewhere). `mode`
scopes severity (goldens/README.md): explicit-cache models FAIL below the
minimum — the lock would promise breakpoints over a cache that cannot
exist — while affinity/implicit models get a loud advisory instead.

```ts
export declare function providerPrefixMinimum(model: string): {
    minimumTokens: number;
    model: string;
    mode: string;
} | undefined;
```

Declared in `packages/agent/dist/cache-planner/static-checks.d.ts`.

### `renderBelowMinimumAdvisory`

The advisory line for affinity/implicit models below their automatic-cache
minimum: the runs still work, they just read cold, and the output says so.

```ts
export declare function renderBelowMinimumAdvisory(diagnostic: {
    prefixTokens: number;
    minimumTokens: number;
    model: string;
}): string;
```

Declared in `packages/agent/dist/cache-planner/static-checks.d.ts`.

### `renderStaticPlanFailure`

Renders a static-plan failure in the F2 voice: plain-words sentence first,
mechanism second, fix third. The wire code appears only with `verbose`.

```ts
export declare function renderStaticPlanFailure(failure: StaticPlanFailure, options?: {
    verbose?: boolean;
}): string;
```

Declared in `packages/agent/dist/cache-planner/static-checks.d.ts`.

### `resolveAnthropicProfile`

```ts
export declare function resolveAnthropicProfile(request: NativeCacheRequest): CachePlanProfile | undefined;
```

Declared in `packages/agent/dist/cache-planner/profiles.d.ts`.

### `resolveBedrockProfile`

```ts
export declare function resolveBedrockProfile(request: NativeCacheRequest): CachePlanProfile | undefined;
```

Declared in `packages/agent/dist/cache-planner/profiles.d.ts`.

### `resolveOpenAIProfile`

```ts
export declare function resolveOpenAIProfile(request: NativeCacheRequest): CachePlanProfile | undefined;
```

Declared in `packages/agent/dist/cache-planner/profiles.d.ts`.

### `withPerturbedClock`

Runs `work` with `globalThis.Date` shifted +26h, restoring it in a finally.
The volatile-prefix check runs its SECOND composition pass under this clock
so day-stable values (`toDateString()`) are caught, not just per-call ones.
The patch is process-global for the duration of `work`; the build pipeline
is sequential there, and nothing else observes wall time mid-composition.

```ts
export declare function withPerturbedClock<T>(work: () => Promise<T>): Promise<T>;
```

Declared in `packages/agent/dist/cache-planner/static-checks.d.ts`.

## Variables & constants

### `AnthropicRollingOptimizerID`

```ts
export declare const AnthropicRollingOptimizerID = "cave-cache-anthropic-rolling-v1";
```

Declared in `packages/agent/dist/cache-planner/types.d.ts`.

### `AnthropicStableOptimizerID`

```ts
export declare const AnthropicStableOptimizerID = "anthropic-cache-breakpoints";
```

Declared in `packages/agent/dist/cache-planner/types.d.ts`.

### `BedrockCacheOptimizerID`

```ts
export declare const BedrockCacheOptimizerID = "bedrock-cache-points";
```

Declared in `packages/agent/dist/cache-planner/types.d.ts`.

### `BedrockRollingOptimizerID`

```ts
export declare const BedrockRollingOptimizerID = "cave-cache-bedrock-rolling-v1";
```

Declared in `packages/agent/dist/cache-planner/types.d.ts`.

### `CODING_CACHE_INPUT_TOKEN_HIT_TARGET`

Warm input-token share target for long-running coding-agent sessions.

```ts
export declare const CODING_CACHE_INPUT_TOKEN_HIT_TARGET = 0.98;
```

Declared in `packages/agent/dist/cache-planner/performance.d.ts`.

### `OpenAIExplicitOptimizerID`

```ts
export declare const OpenAIExplicitOptimizerID = "cave-cache-openai-explicit-v1";
```

Declared in `packages/agent/dist/cache-planner/types.d.ts`.

### `OpenAIKeyOptimizerID`

```ts
export declare const OpenAIKeyOptimizerID = "openai-prompt-cache-key";
```

Declared in `packages/agent/dist/cache-planner/types.d.ts`.

### `ReasonAffinityFallback`

```ts
export declare const ReasonAffinityFallback = "affinity_fallback";
```

Declared in `packages/agent/dist/cache-planner/types.d.ts`.

### `ReasonApplied`

```ts
export declare const ReasonApplied = "applied";
```

Declared in `packages/agent/dist/cache-planner/types.d.ts`.

### `ReasonBelowMinimum`

```ts
export declare const ReasonBelowMinimum = "below_minimum";
```

Declared in `packages/agent/dist/cache-planner/types.d.ts`.

### `ReasonCallerManaged`

```ts
export declare const ReasonCallerManaged = "caller_managed";
```

Declared in `packages/agent/dist/cache-planner/types.d.ts`.

### `ReasonMalformedRequest`

```ts
export declare const ReasonMalformedRequest = "malformed_request";
```

Declared in `packages/agent/dist/cache-planner/types.d.ts`.

### `ReasonNegativeEconomics`

```ts
export declare const ReasonNegativeEconomics = "negative_economics";
```

Declared in `packages/agent/dist/cache-planner/types.d.ts`.

### `ReasonNoExpectedReuse`

```ts
export declare const ReasonNoExpectedReuse = "no_expected_reuse";
```

Declared in `packages/agent/dist/cache-planner/types.d.ts`.

### `ReasonNonPAYG`

```ts
export declare const ReasonNonPAYG = "non_payg";
```

Declared in `packages/agent/dist/cache-planner/types.d.ts`.

### `ReasonNoStablePrefix`

```ts
export declare const ReasonNoStablePrefix = "no_stable_prefix";
```

Declared in `packages/agent/dist/cache-planner/types.d.ts`.

### `ReasonPrefixDrift`

```ts
export declare const ReasonPrefixDrift = "prefix_drift";
```

Declared in `packages/agent/dist/cache-planner/types.d.ts`.

### `ReasonProfileMismatch`

```ts
export declare const ReasonProfileMismatch = "profile_mismatch";
```

Declared in `packages/agent/dist/cache-planner/types.d.ts`.

### `ReasonProviderManaged`

```ts
export declare const ReasonProviderManaged = "provider_managed";
```

Declared in `packages/agent/dist/cache-planner/types.d.ts`.

### `ReasonRecordMode`

```ts
export declare const ReasonRecordMode = "record_mode";
```

Declared in `packages/agent/dist/cache-planner/types.d.ts`.

### `ReasonTransformUnavailable`

```ts
export declare const ReasonTransformUnavailable = "transform_unavailable";
```

Declared in `packages/agent/dist/cache-planner/types.d.ts`.

### `ReasonUnsupported`

```ts
export declare const ReasonUnsupported = "unsupported";
```

Declared in `packages/agent/dist/cache-planner/types.d.ts`.

### `ReasonVolatilePrefix`

```ts
export declare const ReasonVolatilePrefix = "volatile_prefix";
```

Declared in `packages/agent/dist/cache-planner/types.d.ts`.

### `VOLATILITY_CLOCK_SHIFT_MS`

```ts
export declare const VOLATILITY_CLOCK_SHIFT_MS: number;
```

Declared in `packages/agent/dist/cache-planner/static-checks.d.ts`.

