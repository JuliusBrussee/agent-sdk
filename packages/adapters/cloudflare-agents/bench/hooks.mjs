import { performance } from "node:perf_hooks";
import { createCloudflareAgentsAdapter } from "../src/index.js";

const iterations = Number.parseInt(process.env.CAVE_BENCH_ITERATIONS ?? "200000", 10);
if (!Number.isSafeInteger(iterations) || iterations < 1) {
  throw new Error("cave_cloudflare_bench_iterations_invalid");
}

const native = { emit() {} };
const passthrough = createCloudflareAgentsAdapter({ observability: native }).observability;
const observed = createCloudflareAgentsAdapter({
  observability: native,
  onLifecycleEvent() {},
}).observability;
const unmapped = Object.freeze({
  type: "state:update",
  payload: Object.freeze({}),
  timestamp: 0,
});

function measure(name, run) {
  for (let index = 0; index < 10_000; index += 1) run();
  const started = performance.now();
  for (let index = 0; index < iterations; index += 1) run();
  const elapsedMs = performance.now() - started;
  return Object.freeze({
    name,
    iterations,
    elapsedMs: Number(elapsedMs.toFixed(3)),
    nanosecondsPerEmit: Number(((elapsedMs * 1e6) / iterations).toFixed(1)),
  });
}

const results = [
  measure("native", () => native.emit(unmapped)),
  measure("composed_passthrough", () => passthrough.emit(unmapped)),
  measure("composed_observer_unmapped", () => observed.emit(unmapped)),
];
process.stdout.write(`${JSON.stringify({ schemaVersion: 1, results }, null, 2)}\n`);
