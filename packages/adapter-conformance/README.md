# `@caveman-ai/adapter-conformance`

Deterministic candidate-evidence runner for Caveman adapter releases.

`ADAPTER_CONFORMANCE_TEST_VECTOR` owns every case ID, capability assignment,
benchmark clock, warmup count, sample count, percentile, threshold, and vector
digest. Caller selects canonical capabilities and supplies executors for complete
required set. Missing, extra, reassigned, or caller-measured entries fail before
execution.

Canonical capability names come directly from `@caveman-ai/adapter-kit`:

- `runLifecycle`
- `modelInterception`
- `contextTransformation`
- `toolObservation`
- `usageAccounting`
- `streaming`
- `abort`
- `replayAwareness`
- `durableObservation`
- `tracing`
- `compilation`

## Run

```js
import { readFile } from "node:fs/promises";
import {
  ADAPTER_CONFORMANCE_TEST_VECTOR,
  runAdapterConformance,
} from "@caveman-ai/adapter-conformance";

const capabilities = ["runLifecycle"];
const selected = new Set(capabilities);

const report = await runAdapterConformance({
  adapter: {
    id: "fixture",
    packageName: "@caveman-ai/adapter-fixture",
    version: "1.0.0",
  },
  upstream: { packageName: "fixture-sdk", version: "2.0.0" },
  artifacts: {
    adapter: await readFile("./caveman-ai-adapter-fixture-1.0.0.tgz"),
    upstream: await readFile("./fixture-sdk-2.0.0.tgz"),
  },
  capabilities,
  cases: ADAPTER_CONFORMANCE_TEST_VECTOR.cases
    .filter((testCase) => selected.has(testCase.capability))
    .map((testCase) => ({
      id: testCase.id,
      async run(vector) {
        const observedBytes = await executeFixture(vector);
        return { status: "passed", evidence: observedBytes };
      },
    })),
  performance: ADAPTER_CONFORMANCE_TEST_VECTOR.performance
    .filter((benchmark) => selected.has(benchmark.capability))
    .map((benchmark) => ({
      id: benchmark.id,
      run(vector) {
        executeHotHookSynchronously(vector);
      },
    })),
});
```

Hot benchmark callbacks must be synchronous and return `undefined`. Runner warms
them, measures every invocation with monotonic clock captured at module load,
sorts samples, and computes p99. Numeric observations, sample counts, clocks,
and threshold inputs are not accepted from caller. Fixed skip result remains
available when benchmark cannot run; skip blocks capability qualification.

Successful cases return non-empty evidence bytes. Report stores only SHA-256.
`undefined`, malformed results, thrown errors, failed cases, skips, callback
failures, or missed thresholds block qualification. Failure and skip codes pass
through fixed vocabulary; unknown text becomes fixed fallback and never enters
report.

## Evidence boundary

Runner computes adapter and upstream SHA-256 values from supplied artifact
bytes. It accepts no caller-authored package digest, test-vector metadata,
runtime metadata, or performance numbers. Runtime and platform come from current
Node process. Execution is recorded as `uncontained-host`.

Report contains candidate qualification evidence only. Candidate suite ID is
different from adapter-kit certification suite, and candidate `reportDigest`
uses `sha256:<hex>` form rather than manifest evidence shape. This package
exports no API that converts report into manifest `certified` state. External
release process owns certification after independently reproducing results,
checking artifacts, and reviewing adapter behavior.

`reportDigest` covers canonical JSON for every report field except digest itself.
Report inputs are descriptor-snapshotted once. Accessors, symbols, custom
prototypes, cycles, sparse arrays, oversized trees, and unknown fields fail
closed before validation or hashing. Returned report is detached and deeply
frozen.
