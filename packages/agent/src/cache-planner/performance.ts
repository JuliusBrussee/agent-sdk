/** Warm input-token share target for long-running coding-agent sessions. */
export const CODING_CACHE_INPUT_TOKEN_HIT_TARGET = 0.98;

export interface ProviderCacheUsageSample {
  /** Cache ratios exist only when every contributing call came from provider usage. */
  usageBasis: "provider_reported" | "unavailable";
  /** Provider-billed input that was neither a cache read nor cache creation. */
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

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

function usageToken(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("cave_cache_usage_invalid");
  }
  return value;
}

/**
 * Aggregate cache performance without inventing cache eligibility or hits.
 * One unavailable call makes ratio unavailable; mixed evidence is never averaged.
 */
export function analyzeProviderCachePerformance(
  samples: readonly ProviderCacheUsageSample[],
  target = CODING_CACHE_INPUT_TOKEN_HIT_TARGET,
): ProviderCachePerformance {
  if (!Number.isFinite(target) || target < 0 || target > 1) {
    throw new Error("cave_cache_hit_target_invalid");
  }
  if (!Array.isArray(samples)) throw new Error("cave_cache_usage_invalid");

  let uncachedInputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let complete = samples.length > 0;
  for (const sample of samples) {
    if (sample === null || typeof sample !== "object" ||
        (sample.usageBasis !== "provider_reported" && sample.usageBasis !== "unavailable")) {
      throw new Error("cave_cache_usage_invalid");
    }
    complete &&= sample.usageBasis === "provider_reported";
    uncachedInputTokens += usageToken(sample.inputTokens);
    cacheReadTokens += usageToken(sample.cacheReadTokens);
    cacheWriteTokens += usageToken(sample.cacheWriteTokens);
    if (![uncachedInputTokens, cacheReadTokens, cacheWriteTokens].every(Number.isSafeInteger)) {
      throw new Error("cave_cache_usage_invalid");
    }
  }
  const providerInputTokens = uncachedInputTokens + cacheReadTokens + cacheWriteTokens;
  if (!Number.isSafeInteger(providerInputTokens)) throw new Error("cave_cache_usage_invalid");
  const basis = complete && providerInputTokens > 0 ? "provider_reported" : "unavailable";
  const cacheInputTokenHitRatio = basis === "provider_reported"
    ? cacheReadTokens / providerInputTokens
    : null;
  return {
    basis,
    target,
    providerInputTokens,
    uncachedInputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cacheInputTokenHitRatio,
    targetMet: cacheInputTokenHitRatio === null ? null : cacheInputTokenHitRatio >= target,
  };
}
