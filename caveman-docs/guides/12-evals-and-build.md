# Evals and Cave Build

`npm run build` runs your declared evals and, when everything passes, writes an
immutable proof envelope. **A failed eval never produces a lock.**

## Declaring evals

```ts
import { eval as defineEval } from "@caveman-ai/agent";

export const refund = defineEval({
  id: "refund",
  input: "Can I get a refund?",
  quality: [
    { type: "contains", fragments: ["14 days"] },
    { type: "tool_called", tools: ["lookup_policy"] },
  ],
});
```

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `string` | Unique fixture id |
| `lineageId` | `string` | Stable task-family identifier. **Required** by profile-guided split isolation |
| `split` | `"profile" \| "development" \| "holdout"` | Explicit compiler role. Omit for legacy v2 builds |
| `input` | `unknown` | The task |
| `tools` | `{ mode: "fixture" \| "live"; sandbox?: string }` | How tools behave during the eval |
| `quality` | `QualityGrader[]` | See below |
| `guardrails` | `EvalGuardrail[]` | `{ type: "latency_threshold", p95_ms }` or `{ type: "error_rate", max }` |

### Compiler-lowerable graders

The native compiler can lower these without a model or network dependency:

```text
contains | not_contains | tool_called | exact_match | json_schema
```

`exact_match` uses canonical eval semantics — trimmed, case-insensitive text by
default; `case_sensitive` and `remove_punctuation` opt into stricter variants.

The **full** grader taxonomy (27 canonical names, including the network and
model-assisted ones) belongs to `@caveman-ai/evals`; see
[the evals package reference](../reference/api/evals.md) and
[`packages/evals/README.md`](../../packages/evals/README.md).

## The split-role (v3) build

```ts
export const profile = defineEval({
  id: "profile-a", lineageId: "profile-family", split: "profile",
  input: "representative task",
  quality: [{ type: "exact_match", expected: "expected result" }],
});
export const development = defineEval({
  id: "development-a", lineageId: "development-family-a", split: "development",
  input: "different representative task",
  quality: [{ type: "exact_match", expected: "expected result" }],
});
export const holdout = defineEval({
  id: "holdout-a", lineageId: "holdout-family-a", split: "holdout",
  input: "unseen representative task",
  quality: [{ type: "exact_match", expected: "expected result" }],
});
```

A v3 build requires **every** fixture to declare a role and a `lineageId`. It
never invents or randomly splits holdout evidence.

Order of operations:

1. Profile evals (or imported traces) characterize the workload.
2. Candidate plans search on `development`.
3. The winner **freezes**.
4. Untouched `holdout` opens.

Native plan cost may not exceed baseline in either split.

### Importing existing traces

Content-blind rows under `.caveman/traces/` can supply profile evidence and skip
profile-eval spend. The envelope is deliberately tiny; `trace` may be a Caveman
`RunResult`, an OpenTelemetry span, or an OpenInference span:

```json
{"schema_version":1,"case_id":"case-a","lineage_id":"family-a","input_sha256":"0123…","agent_sha256":"abcd…","trace":{"traceId":"…","spanId":"…","attributes":{}}}
```

Raw prompt and result span attributes are **refused**. Generic OTel and
OpenInference spans always stay unpriced; only strict Caveman evidence can be
repriced from the pinned public catalog.

## What can actually be lowered

| Lane | What a build may change |
| --- | --- |
| Exact first-party native Pi (`tool-free-v1`), **tool-free agents only** | Priced model, lower reasoning effort, reversible Context IR routes with derived recovery, lower output budget |
| Generic/custom Pi, Vercel AI SDK, Eve, Mastra | Nothing. Baseline-equivalent, empty capabilities, only `profile_guided_selection` |
| Claude | Cave Build compilation and registration **refuse** |

Any root tool — including a subagent — refuses before runner spend with
`cave_compiler_tool_effect_coverage_unavailable`. Required semantics and sorted
passes must exactly match the plan diff. Every failure aborts; the embedded
baseline pointer is manual recovery, never an automatic second paid attempt.

## `defineBuild`

```ts
import { defineBuild } from "@caveman-ai/agent/build";

export default defineBuild({
  entry: ".",                    // "." resolves the agent-directory convention
  evals: "evals",
  efficiency: "max",
  requiredFixturePassRate: 1,
  qualityRetention: 1,
  maxSearchCostUsd: 2,
  lock: "strict",
  sandbox: "required",
  allowedModels: ["anthropic/claude-sonnet-4-6"],
  deniedModels: [],
  maxP95LatencyMs: 30_000,
  forbiddenSafetyClasses: ["S3", "S4"],
  dataResidency: "eu",
});
```

## Artifacts a successful build writes

| File | Contents |
| --- | --- |
| `.caveman/agent.lock.json` | The Cave Build proof envelope (v3 native behavioral, or generic/external baseline) |
| `.caveman/workload-profile.json` | Content-blind profile and provenance |
| `.caveman/build-report.json` | Search cost, holdout evidence, passes, claims, and a local `inferred` `break_even_tasks` point estimate — `null` unless total actual search cost is complete and the holdout catalog delta is positive |
| `.caveman/frozen-prefix.json` | The prefix baseline the shrink check compares against |

## Compile statuses

```ts
type CompileStatus =
  | "locked"
  | "no_passing_build"
  | "needs_eval"
  | "search_budget_exceeded"
  | "incomplete_evidence";
```

No v3 proof envelope is written when usage is missing, the model is unpriced,
cache regresses, recovery fails, sandbox or privacy checks fail, quality drops,
search is incomplete, or the cost ceiling is exceeded.

## Static checks run before the eval gate

Three plan checks run **before** any model-backed eval spends anything:

1. **Volatile frozen prefix.** Composition runs twice, the second pass under a
   `+26h` perturbed clock, so even day-stable values trip. The failure names the
   file, the mechanism, and the fix.
2. **Prefix-shrink regression** against `.caveman/frozen-prefix.json`. Reset the
   baseline deliberately with `--accept-prefix-shrink`; if the build then stops
   before locking, no new baseline is written.
3. **Frozen prefix below the provider's catalog minimum.** Build-failing for
   explicit-cache models, a loud advisory for affinity/implicit ones.

Wire codes appear only under `caveman-agent build --verbose`.

## Preflight and cost

Preflight prints a **static one-call reservation estimate**, not a full
multi-turn ceiling. Terminal provider overage stays visible, and the remaining
max-cost budget hard-stops new candidate calls.

## Checking before deployment

```bash
caveman-agent check [config]
```

`check` rejects drift before any model call. Parsing a lock alone does not
establish freshness — source, config, and eval freshness is project-level state,
and `check` is the deployment/startup gate for it.

## Running a lock

```ts
import { readFile } from "node:fs/promises";
import { runLocked } from "@caveman-ai/agent";
import { parseAnyCaveBuildLock } from "@caveman-ai/agent/build";

const build = parseAnyCaveBuildLock(
  JSON.parse(await readFile(".caveman/agent.lock.json", "utf8")),
);
const result = await runLocked(support, "Can I get a refund?", build, {
  durable: { runId: "case-42-analysis-1" },
  budget: { maxTokens: 12_000, onExhausted: "stop" },
});
```

`runLocked()` accepts only Pi locks. A Pi lock can never authorize Claude or
third-party execution. See [Execution modes](../concepts/execution-modes.md) for
everything it validates first.

## Programmatic compilation

```ts
import {
  compileProfiledNativePi,
  createCompilerWorkloadProfile,
  normalizeTrajectory,
} from "@caveman-ai/agent";

const profile = createCompilerWorkloadProfile([
  normalizeTrajectory(profileRun, {
    split: "profile", caseId: "case-1", lineageId: "family-1",
    inputSha256: "0123…",
  }),
]);

const result = await compileProfiledNativePi({
  ...nativeCompilerInput,
  rootDir: process.cwd(),
  entryPath: "src/agent.ts",
  profile,
  developmentEvals,
  holdoutEvals,
});

if (result.status !== "locked") throw new Error(result.reason ?? result.status);
console.log(result.lock.build_sha256);
```

Callers cannot inject native candidates, runners, or target identity.
`compileProfiled` is the generic caller-owned-runner API and emits
baseline-equivalent v3 only.

## What a build hash is not

Build, compiler, and adapter-contract hashes bind canonical bytes for integrity.
They are not signatures, binary or SBOM provenance, runtime attestation, or
proof that the registered bytes served production traffic.

Full API: [`@caveman-ai/agent/build`](../reference/api/agent/build.md),
[`@caveman-ai/agent/compiler`](../reference/api/agent/compiler.md),
[`@caveman-ai/agent/profile`](../reference/api/agent/profile.md).
