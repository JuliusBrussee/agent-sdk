# The honesty model

Every number this SDK reports carries a basis. The rules below are enforced in
code and in tests, not just in prose — they are the reason several paths refuse
to return a value at all.

## Claim bases

| Basis | Meaning | Where it comes from |
| --- | --- | --- |
| `inferred` | A local estimate from your own traffic | Anything computed on your machine: transform traces, context estimates, compiler evidence |
| `measured` | Observed traffic | Provider-reported usage on a completed call |
| `verified` | Compared against a bill | Reserved. Nothing in this repository emits it |

`verifiedSavingsUsd` is always `0` here. It stays `0` until real production
traffic passes separate rollout and ledger gates that live outside this SDK.
The SDK publishes no savings percentage.

## Cost bases

- **`priceBasis: "public_catalog"`** — a list-price subtotal recomputed from the
  pinned catalog snapshot. It is not an invoice, a quota, or a cross-process
  reservation.
- **Unknown price** — a model the public catalog cannot price cannot be capped.
  With a USD cap set, such a call fails closed rather than consuming an
  imaginary `$0` of budget.
- **`costUsd: null`** means *unknown*. Consumers must render "unknown", never
  "$0 spent". This rule is frozen into the Pebble protocol as well.

## Usage bases

- **`usageBasis: "provider_reported"`** — the provider returned complete,
  arithmetically consistent counts for the call.
- **Incomplete usage** — the run does not silently substitute zero. Cave Builds
  and subagent accounting fail closed; unlocked runs label the gap.
- **`reasoningUsageBasis`** is separate from `usageBasis`. When a
  reasoning-capable model omits the optional split, unlocked runs label it
  unavailable. `reasoningTokens: 0` alongside
  `reasoningUsageBasis: "unavailable"` is a non-evidence placeholder and must
  not be read as a measured zero.

## Fail-closed rules

Unknown model, pricing, usage, grader, runtime, or sandbox state fails closed or
stays explicitly unknown. Concretely:

- A USD budget on a model the catalog cannot price refuses before the first call.
- A USD budget on Pi's own transport is refused when the local credential store
  cannot prove the credential is metered per token — an unprovable billing
  regime would book fictional dollars against what may be a subscription.
  `RunOptions.assumeMeteredCredential: true` is the explicit caller assertion.
- A run carrying a Cave Build lock or a candidate plan never degrades silently
  to observe-only; it fails with `cave_gateway_required_for_locked_plan`.
- `sandbox: "required"` fails closed where no verified OS containment exists.
- A build writes no v3 proof envelope when usage is missing, the model is
  unpriced, cache regresses, recovery fails, sandbox or privacy checks fail,
  quality drops, search is incomplete, or a cost ceiling is exceeded.
- Connect reads never silently summarize or skip records; a capped result
  returns `complete: false` and `must_refuse: true`.
- Unknown grader types return `passed: false`.

## What "host sandbox" means

`sandbox: "host"` means uncontained host execution. It is never described as
isolation, is never a default, cannot sit under a `required` ancestor, and makes
a build lock-ineligible. Calling it a sandbox in documentation is treated as a
correctness bug in this repo, not a wording preference.

## What a build hash is and is not

Build, compiler, and adapter-contract hashes bind canonical bytes for
integrity. They are **not** signatures, binary or SBOM provenance, runtime
attestation, or proof that the registered bytes served production traffic.

## Token reduction is not savings

Fewer input tokens can still cost more when retrieval causes extra model turns,
collection is expensive, data is stale, or the agent retries after incomplete
context. Compare total task cost — provider calls, retry and follow-up calls,
retrieval, and collection — and count task success separately. The cheapest
failed answer is not efficient.

## Observe-only claims nothing

In `observe-only` mode the SDK calls your provider directly: no transforms, no
gateway telemetry, no efficiency claim. Provider usage and local context
estimates still work. An observe-only path that claimed optimization would
violate the repo's non-negotiable rules.
