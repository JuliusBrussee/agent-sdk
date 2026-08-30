import { performance } from "node:perf_hooks";
import { createMastraAdapter, normalizeMastraUsage } from "../src/index.js";

const iterations = 250_000;
const processor = createMastraAdapter();
const state = {};
const part = Object.freeze({
  type: "text-delta",
  payload: Object.freeze({ id: "text", text: "x" }),
});
const args = Object.freeze({ state, retryCount: 0, part });

for (let index = 0; index < 10_000; index++) await processor.processOutputStream(args);
let started = performance.now();
for (let index = 0; index < iterations; index++) await processor.processOutputStream(args);
const streamNs = ((performance.now() - started) * 1e6) / iterations;

const usage = Object.freeze({
  inputTokens: 20,
  outputTokens: 5,
  totalTokens: 25,
  cachedInputTokens: 4,
  cacheCreationInputTokens: 1,
  reasoningTokens: 1,
});
const identity = Object.freeze({ provider: "bench", model: "model" });
for (let index = 0; index < 10_000; index++) normalizeMastraUsage(usage, identity);
started = performance.now();
for (let index = 0; index < iterations; index++) normalizeMastraUsage(usage, identity);
const usageNs = ((performance.now() - started) * 1e6) / iterations;

console.log(JSON.stringify({
  iterations,
  streamPassthroughNsPerOperation: Math.round(streamNs),
  usageNormalizationNsPerOperation: Math.round(usageNs),
}, null, 2));
