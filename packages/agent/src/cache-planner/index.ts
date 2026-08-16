// In-SDK deterministic cache planner + provider wire bridges (Agent SDK v2
// phase 2). TS port of public/cacheengine's planner core and the three wires
// the SDK sends to (Anthropic native, OpenAI chat + responses, Bedrock
// converse + invoke). The Go engine remains the source of truth; parity is
// pinned by planner-fixtures/{planner,wire}.json.
export { CachePlanEngine, detectVolatile } from "./engine.js";
export { optimizeNativeRequest } from "./wires.js";
export type {
  CacheAttribution,
  CacheBreakpoint,
  CacheDecision,
  CacheEngineConfig,
  CacheMode,
  CachePlan,
  CachePlanProfile,
  CachePlanProfileInput,
  CachePlanRequest,
  CachePlanSegment,
  NativeCacheRequest,
  NativeCacheResult,
} from "./types.js";
