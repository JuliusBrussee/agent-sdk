// Public deterministic CacheEngine + provider wire bridges. TS port of
// public/cacheengine's planner core and native provider wires. Go remains
// parity authority through planner-fixtures/{planner,wire}.json.
export {
  CachePlanEngine,
  CachePlanEngine as CacheEngine,
  detectVolatile,
} from "./engine.js";
export * from "./profiles.js";
export * from "./performance.js";
export * from "./static-checks.js";
export * from "./types.js";
export { optimizeNativeRequest } from "./wires.js";
