# Compiler replay benchmark

`compiler-replay.mjs` is a zero-network, deterministic **future-pass structural
rehearsal**. Its machine-readable subject is
`future_profiled_dead_structure_elimination_fixture`. It does not import or run
current `@caveman-ai/agent` `compileProfiled`, CaveBuild v3 parsing/execution, or any
target adapter. Therefore `current_v0_2_release_proof` is always `false`.

Runner executes neither model nor upstream verifier. It proves no current
compiler conformance, task correctness, causal token/cost/latency effect,
production outcome, observed savings, or verified savings.

The runner profiles four training families, considers two structural plans,
selects on four development families, locks that plan, and only then evaluates
four disjoint held families. The sole optimized plan removes one tool schema and
one context segment that were absent from the training observations. Model-call
counts and tool sequences must remain identical.

## Evidence boundary

- `benchmark_subject`: `future_profiled_dead_structure_elimination_fixture`
- `current_v0_2_release_proof`: `false`
- `evidence_basis`: `synthetic_structural_rehearsal`
- `causal`: `false`
- `publishable`: `false`
- replay inputs: pinned `task.md` file bytes; fixture-declared tool-schema
  and fixed-context byte weights; deterministic calls and tool-sequence digests
- external verifier: not executed; result `unavailable`
- internal consistency check: pinned verifier-file hashes stay unchanged and
  fixture-declared outcome metadata hashes match between plans
- not measured: provider tokens, money, wall-clock compiler overhead, search
  spend, and break-even volume

Outcome digest is constructed from fixture-declared task, call, tool-sequence,
context-requirement, and pinned-file metadata. Equality is useful for runner
regression detection, but is not independent verification.

Declared schema and fixed-context weights are synthetic replay metadata, not
captured provider payloads. They rehearse accounting and plan-safety logic for a
possible future dead-structure pass. Only current compiler integration plus live
paired execution can establish compiler behavior or runtime work reduction.

## Run

From the repository root:

```bash
node public/agent/bench/compiler-replay.mjs --check
node public/agent/bench/compiler-replay.mjs
node --test public/agent/bench/tests/*.test.mjs
```

The normal run writes `compiler-replay-report.json`. `--check` performs all
validation, rebuilds in memory, and requires both canonical-JSON equality and
byte equality with the checked-in report.

The runner fails closed when:

- the third-party manifest's training-use constraint or approved benchmark role
  is not the exact approved value;
- the corpus manifest, any vendored file, or fixture hash differs;
- task sets or train/dev/held cardinalities differ;
- a task or family occurs in more than one split;
- candidate selection reads held evidence;
- the selected plan removes a required tool or context segment;
- declared model calls, tool sequences, pinned verifier-file bundles, or
  constructed outcome digests change.

## Live paired protocol

Future-pass rehearsal is not a release gate. Causal current-compiler benchmark
must first import and execute current compiler, v3 artifact, and target adapter,
then run fresh paired executions:

1. Freeze corpus, family split, compiler, adapter, model snapshot, provider
   settings, catalog, seeds, and analysis before opening held tasks.
2. Profile on train only; choose candidates on dev only; execute held once.
3. Pair uncompiled and compiled arms by task, adapter, model, and seed. Rotate
   arm order. Keep all failures in quality and cost-per-success calculations.
4. Require exact task verification plus a predeclared quality non-inferiority
   gate before evaluating efficiency.
5. Use provider-reported token buckets and public-catalog cost. Cluster the
   confidence interval by task family; repetitions do not replace independent
   families.
6. Report all model calls, turns, tool reads/writes, retries, tool-result bytes,
   schemas exposed, context bytes, cache events, recovery/fallbacks, and p95
   latency.
7. Record compiler profile/search spend. Define break-even only when both that
   spend and a positive paired runtime cost delta are measured.
8. Keep the result `benchmark_counterfactual`; production observation and
   verified savings require the Cloud ledger predicates.

Checked-in 12-task rehearsal is synthetic structural fixture, not current
compiler conformance evidence and not enough independent held families for any
public efficiency claim.

## Third-party data

[`third-party-data.json`](third-party-data.json) pins source URL, commit,
license, task count, corpus manifest hash, fixture hash, redistribution and
training-use constraints, plus approved benchmark role. Upstream files remain
in `internal/agentbench/corpus/`; this directory creates no second copy. The
training-use constraint and approved role are copied into the report and thus
bound into its canonical `report_sha256`.
