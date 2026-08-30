import { hrtime } from "node:process";

import { createAdapterLifecycleValidator } from "../src/index.js";

const WARMUP_SAMPLES = 10_000;
const MEASURED_SAMPLES = 50_000;
const P50_LIMIT_MICROSECONDS = 25;
const P99_LIMIT_MICROSECONDS = 100;

const validator = createAdapterLifecycleValidator({
  maxRuns: 1,
  maxScopesPerRun: 1,
});
let seq = 0;

accept("run.started", {});
accept("checkpoint.committed", { stepId: "step-1" });

for (let index = 0; index < WARMUP_SAMPLES; index += 1) {
  accept("checkpoint.committed", { stepId: "step-1" });
}

const samples = new Float64Array(MEASURED_SAMPLES);
for (let index = 0; index < MEASURED_SAMPLES; index += 1) {
  const started = hrtime.bigint();
  accept("checkpoint.committed", { stepId: "step-1" });
  samples[index] = Number(hrtime.bigint() - started) / 1_000;
}

samples.sort();
const p50 = percentile(samples, 0.50);
const p99 = percentile(samples, 0.99);
const result = Object.freeze({
  schema: "caveman.adapter-kit.lifecycle-benchmark.v1",
  runtime: Object.freeze({ name: "node", version: process.versions.node }),
  samples: MEASURED_SAMPLES,
  unit: "microseconds",
  p50,
  p99,
  thresholds: Object.freeze({
    p50: P50_LIMIT_MICROSECONDS,
    p99: P99_LIMIT_MICROSECONDS,
  }),
  passed: p50 <= P50_LIMIT_MICROSECONDS && p99 <= P99_LIMIT_MICROSECONDS,
});

process.stdout.write(`${JSON.stringify(result)}\n`);
if (!result.passed) process.exitCode = 1;

function accept(phase, scope) {
  seq += 1;
  validator.accept({
    schemaVersion: 1,
    seq,
    phase,
    identity: {
      runId: "run-1",
      ...scope,
      attempt: 1,
      replay: false,
      nativeIds: {},
    },
  });
}

function percentile(values, quantile) {
  return values[Math.ceil(values.length * quantile) - 1];
}
