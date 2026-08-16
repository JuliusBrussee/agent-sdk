# Goldens — the spec is the fixture

Hand-written first, per the last-20% ordering rule in
`docs/strategy/AGENT_SDK_V2_SHAPE.md`: these artifacts land BEFORE the
generators that produce them. Every renderer built in phases 1–4 is
snapshot-tested against these exact bytes. Editing a golden is a product
decision, not a test fix.

## Snapshot contract

The receipt renderer is a pure function: receipt JSON in, text out. Each
golden pairs with a checked-in receipt fixture whose timestamps, durations,
and run paths are pinned values — so the snapshot is byte-exact with **no
normalizer**. Live runs produce different timestamps; the test never runs
live. All dollar figures in the fixtures are computed from the real
`catalog.ts` list prices — a golden may not contain a number the catalog
cannot produce.

## Receipt prints (F1)

| File | Case | Done-criteria it pins |
|---|---|---|
| `receipt-cold.txt` | First run of the scaffold, prefix written to cache | the first receipt a user ever sees: cost is ABOVE the cold estimate (cache-write premium) and the receipt says why in place — no unexplained backwards-reading line |
| `receipt-warm.txt` | Second run of the scaffold, prefix read warm | warm reads from provider aggregate (measured); cold counterfactual labeled `inferred`; the word "saved" appears nowhere; cost labeled list-price subtotal, not an invoice |
| `receipt-unpriced.txt` | Model missing from the catalog | honest flag instead of $0; USD budget with an unpriced model is a build/run failure (`failures/unpriced-model.txt`), so this receipt is the token-cap path |
| `receipt-zero-turn.txt` | Run ended before any model call | honest absence, no fabricated zeros |

Every receipt carries a `mode` line (F8): observe-only names its upgrade
(`engine adds compression + recovery`); no degrade is silent. Rendered by
default at the end of `run` and of every `dev` turn.

## Failure voice (F2)

The six most common build failures, hand-written at golden fidelity BEFORE
the diagnostics that emit them are wired. (The spec's original list had
five; `prefix-below-minimum` was added at Phase-0 review — it is the
failure mode that silently kills the flagship second-run moment, so it
needs a voice more than any of the others.) Voice rule: plain-words
sentence first, mechanism second, fix third. Wire codes are demoted to
`--verbose`; the mapping lives here, not in the default output:

| File | Wire code (verbose-only) |
|---|---|
| `failures/volatile-prefix.txt` | `cave_frozen_prefix_volatile_segment` (net-new, phase 2) |
| `failures/prefix-shrink.txt` | `cave_prefix_shrink_regression` (net-new, phase 2) |
| `failures/prefix-below-minimum.txt` | `cave_frozen_prefix_below_provider_minimum` (net-new, phase 2) |
| `failures/eval-gate.txt` | existing eval-gate fail statuses (`build.ts` `CompileStatus`) |
| `failures/unpriced-model.txt` | `cave_compiler_profile_model_unpriced` / `cave_subagent_unpriced_budget` |
| `failures/host-sandbox.txt` | `cave_host_sandbox_lock_ineligible` |

Eval-gate rendering contract: profile-split fixtures are never graded
pass/fail — they produce the workload profile and render as a separate
`profiled N fixtures` line. Only development evals gate selection;
holdout opens after freeze.

Ordering contract: **static plan checks (volatile prefix, prefix shrink,
prefix below minimum, unpriced model, host-mode lock) run BEFORE the eval
gate.** They are free
and deterministic; a build with unapproved evals still fails fast on a
static violation instead of printing `needs_eval`. Phase 2 implements this
order; the scaffold's "try breaking it" walkthrough depends on it.

Volatility is detected by hashing the lowered frozen prefix across two
build passes, with the second pass run under a perturbed clock (+26h) so
day-stable values like `toDateString()` are caught, not just per-call
ones — a literal `${new Date()}` inside a markdown file is inert text
and does NOT trip it; the real hazard is a build-stable context segment
computed in `agent.ts`, which is exactly what the golden shows.

Severity scoping (2026-08-15 Phase-2 review): `prefix-below-minimum`
FAILS the build only for explicit-cache models, where the lock would
promise breakpoints over a cache that cannot exist. Affinity/implicit
models (automatic provider caching, no plan-owned breakpoints) get a
loud advisory line in the build output instead — below the minimum the
runs still work, they just read cold, and the output says so. Token
figures in these messages are local estimates (the build's own planning
basis), labeled as such in the goldens.

## Honesty constraints these goldens encode

- No savings vocabulary anywhere. The cold estimate is a counterfactual,
  labeled `inferred`, never subtracted into a "saved" figure.
- Costs are public-catalog list-price subtotals, never invoices, and say so.
- Unpriced models fail closed or print their honest flag — never $0.
- Every degrade names its upgrade (F8), no silent modes.
