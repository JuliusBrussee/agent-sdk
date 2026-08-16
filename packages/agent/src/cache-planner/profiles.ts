// TS port of public/cacheengine/profiles.go: provider cache profiles resolved
// from the generated catalog (src/catalog.ts, single pricing source of truth).
// Multipliers are grounded catalog rates or unknown — never guessed; a model
// the catalog cannot describe resolves no profile and the request passes
// through unchanged.
import { catalogCacheProfile, type CatalogCacheProfile } from "../catalog.js";
import type { CacheAttribution, CacheMode, CachePlanProfile, NativeCacheRequest } from "./types.js";
import {
  AnthropicStableOptimizerID,
  BedrockCacheOptimizerID,
  OpenAIExplicitOptimizerID,
  OpenAIKeyOptimizerID,
} from "./types.js";

function knownRate(rate: number | null): rate is number {
  return rate !== null && rate >= 0;
}

function catalogEntry(request: NativeCacheRequest): CatalogCacheProfile | undefined {
  const entry = catalogCacheProfile(request.provider, request.model ?? "", request.region);
  if (entry === undefined) return undefined;
  const endpoint = (request.endpoint ?? "").trim().replace(/^\//, "");
  return entry.endpoints.includes(endpoint) ? entry : undefined;
}

function baseProfile(request: NativeCacheRequest, entry: CatalogCacheProfile): CachePlanProfile {
  return {
    id: entry.id,
    provider: request.provider.toLowerCase().trim(),
    mode: entry.mode as CacheMode,
    attribution: entry.attribution as CacheAttribution,
    minPrefixTokens: entry.minPrefixTokens,
    maxBreakpoints: entry.maxBreakpoints,
    economicsKnown: false,
    writeMultiplier: 0,
    readMultiplier: 0,
    ttlSeconds: entry.ttlSeconds,
    rolling: entry.rolling,
    routingKey: entry.routingKey,
    maxRpmPerKey: entry.maxRpmPerKey,
    optimizerId: "",
  };
}

function catalogRates(
  entry: CatalogCacheProfile,
): { input: number; read: number; write: number | null } | undefined {
  if (entry.inputPerMillion === null || entry.inputPerMillion <= 0 ||
      !knownRate(entry.cacheReadPerMillion)) {
    return undefined;
  }
  return {
    input: entry.inputPerMillion,
    read: entry.cacheReadPerMillion,
    write: entry.cacheWritePerMillion,
  };
}

function strictMultipliers(
  entry: CatalogCacheProfile,
): { write: number; read: number } | undefined {
  const rates = catalogRates(entry);
  if (rates === undefined || !knownRate(rates.write)) return undefined;
  return { write: rates.write / rates.input, read: rates.read / rates.input };
}

function openAIMultipliers(
  entry: CatalogCacheProfile,
): { write: number; read: number } | undefined {
  const rates = catalogRates(entry);
  if (rates === undefined) return undefined;
  if (entry.mode === "explicit") {
    if (!knownRate(rates.write)) return undefined;
    return { write: rates.write / rates.input, read: rates.read / rates.input };
  }
  if (entry.mode !== "affinity") return undefined;
  if (knownRate(rates.write)) {
    return { write: rates.write / rates.input, read: rates.read / rates.input };
  }
  // Affinity caching has no separately billed write. One miss costs normal
  // input rate, so the grounded write multiplier is exactly one.
  return { write: 1, read: rates.read / rates.input };
}

export function resolveAnthropicProfile(request: NativeCacheRequest): CachePlanProfile | undefined {
  const entry = catalogEntry(request);
  if (entry === undefined || entry.id !== "cave-cache-anthropic-v1" ||
      entry.mode !== "explicit" || entry.attribution !== "causal") {
    return undefined;
  }
  const multipliers = strictMultipliers(entry);
  if (multipliers === undefined) return undefined;
  const profile = baseProfile(request, entry);
  profile.economicsKnown = true;
  profile.writeMultiplier = multipliers.write;
  profile.readMultiplier = multipliers.read;
  profile.optimizerId = AnthropicStableOptimizerID;
  return profile;
}

export function resolveOpenAIProfile(request: NativeCacheRequest): CachePlanProfile | undefined {
  const entry = catalogEntry(request);
  if (entry === undefined) return undefined;
  const multipliers = openAIMultipliers(entry);
  if (multipliers === undefined) return undefined;
  const profile = baseProfile(request, entry);
  profile.economicsKnown = true;
  profile.writeMultiplier = multipliers.write;
  profile.readMultiplier = multipliers.read;
  if (entry.id === "cave-cache-openai-explicit-v1" && entry.mode === "explicit" &&
      entry.attribution === "causal") {
    profile.optimizerId = OpenAIExplicitOptimizerID;
  } else if (entry.id === "cave-cache-openai-affinity-v1" && entry.mode === "affinity" &&
      entry.attribution === "affinity") {
    profile.optimizerId = OpenAIKeyOptimizerID;
  } else {
    return undefined;
  }
  return profile;
}

export function resolveBedrockProfile(request: NativeCacheRequest): CachePlanProfile | undefined {
  const entry = catalogEntry(request);
  if (entry === undefined || entry.id !== "cave-cache-bedrock-v1" ||
      entry.mode !== "explicit" || entry.attribution !== "causal") {
    return undefined;
  }
  const multipliers = strictMultipliers(entry);
  if (multipliers === undefined) return undefined;
  const profile = baseProfile(request, entry);
  profile.economicsKnown = true;
  profile.writeMultiplier = multipliers.write;
  profile.readMultiplier = multipliers.read;
  profile.optimizerId = BedrockCacheOptimizerID;
  return profile;
}
