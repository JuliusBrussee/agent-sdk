# Glossary

**Agent directory** — The filesystem-first convention: `instructions.md` +
`agent.ts` + `tools/` + `skills/` + `subagents/`, composed by `loadAgentDir()`
into one ordinary `agent()` call. See [guide](../guides/03-agent-directory.md).

**Anchor** — A typed reference inside a `cave.context-summary.v2` capsule. A
*critical* anchor must survive byte-identically across a compaction generation
unless a later user-grounded source supersedes it with an explicit edge.

**Basis** — The provenance label on a number. `claimBasis` is `inferred`,
`measured`, or (reserved, never emitted here) `verified`. `usageBasis` is
`provider_reported` or `unavailable`. `priceBasis` is `public_catalog` or
`unpriced`.

**Breaker** — A deterministic circuit breaker: repeated-tool-call loop detection,
no-progress windows, per-turn fan-out cap, budgeted retry. No model participates
in any breaker decision.

**Cache epoch** — The window inside which the provider-visible stable prefix stays
byte-stable. A definition, model, or plan change rotates the epoch rather than
replaying stale bytes.

**Cave Build** — The immutable proof envelope a successful `caveman-agent build`
writes to `.caveman/agent.lock.json`. v2 is the legacy unsplit form; v3 is the
split-role profile-guided form.

**CCR (exact byte-recovery)** — The recovery class where original bytes can be
restored exactly, through the framework `cave_retrieve` tool. Only
CCR-recoverable transforms are eligible for a default plan.

**Claim basis** — See *Basis*.

**Clamp** — The budget rung that lowers an outgoing call's output allowance to
what the remaining budget affords. Below `OUTPUT_CLAMP_FLOOR_TOKENS` (256) the
run stops instead.

**Content-blind** — Evidence carrying no prompt, result, tool, or error content —
only digests, counts, and identifiers. Profile traces and gateway telemetry are
content-blind.

**Context IR** — The lowered, content-blind representation of context the
compiler reasons about. A lock binds **static** Context IR only.

**Denomination** — The unit a run's budget is metered in: `usd` or `tokens`.
Exactly one per run, declared up front, and refused when it cannot be honestly
metered.

**Effect** — A tool's declared side-effect class: `read`, `write`, `idempotent`,
`external`. Mandatory in every sandbox mode.

**Epoch** — See *Cache epoch*.

**Eval split** — `profile`, `development`, or `holdout`. A v3 build searches on
development, freezes, then opens untouched holdout.

**Fail closed** — Refusing to produce a value when the evidence for it is
missing, rather than substituting a default. Unknown model, pricing, usage,
grader, runtime, or sandbox state fails closed.

**Fixture mode** — `sandbox: "fixture"`: trusted test tools in the host process,
with `effect: "write"` blocked rather than executed. Not a security boundary.

**Frozen prefix** — The build-stable, provider-visible portion of context.
Volatile data in it is rejected.

**Gated (cache)** — The wire transport's default: only cache grammars proven
against a live provider are released. Today that is the OpenAI affinity routing
key alone.

**Holdout** — Eval fixtures the candidate search never saw. Opened only after the
winner is frozen.

**Host mode** — `sandbox: "host"`: closures run in-process, uncontained, and
writes execute. Never a default, refused under a `required` ancestor, and
lock-ineligible.

**Inferred** — A local estimate from your own traffic. The strongest claim any
local path in this repository makes.

**Lineage** — `lineageId`, the stable task-family identifier that keeps
profile/development/holdout splits isolated.

**Lock** — See *Cave Build*.

**Model boundary** — The adapter seam where `prepare(request, context)` returns a
**replacement** request. Home of compaction and model routing.

**Observe-only** — The execution mode where the SDK calls your provider directly:
no transforms, no gateway telemetry, no efficiency claim.

**Optimized** — The execution mode routed through the local Caveman gateway with
eligible transforms and context telemetry.

**Programmatic mode** — One `caveman_code` tool instead of a JSON tool wall; the
model writes a bounded cell that dispatches nested tools through the canonical
kernel.

**Receipt** — `RunReceipt`: per-call, per-tool, per-subagent breakdown plus
tranches, breakers, compactions, and resume evidence. Returned on success and
carried on `CavemanRunError` after a failure.

**Required mode** — `sandbox: "required"`: tool code runs in a separate
OS-isolated subprocess under a kernel network boundary plus the Node permission
model. The default.

**Reserve-and-clamp** — The single budget enforcement mode: hold each call's
worst case before it leaves, clamp its output when the remainder cannot fund the
full allowance, stop below the floor.

**Result policy** — What happens to a tool result: `auto`, `inline`, `page`,
`compress`, `exact_ccr`.

**Route** — A Context IR transform assignment for one live-zone segment kind. Two
routes matching one runtime segment collapse into `dynamic_route_ambiguous` and
the segment passes through untouched.

**Skill** — Markdown with `name` + one-line `description` frontmatter. The
description enters the stable prefix; the body is served on demand by the
framework `cave_skill` tool.

**Speculation** — Starting a complete literal `effect: "read"` call while the
provider is still streaming the composite cell. Never applied to writes,
idempotent operations, external calls, variable-dependent arguments, or reads
after possible writes.

**Stability** — A context segment's cache zone: `build` (frozen prefix),
`session`, or `turn` (live zone).

**Subagent wallet** — Under a metered run, a subagent's `maxCostUsd` / `maxTokens`
carved out of the parent's *remaining* budget at spawn, with the unspent
remainder returned when the child finishes.

**Tranche** — One staged budget release: amount, reason, and the call index it
happened at. Recorded on the receipt.

**Verified** — Reserved for a system that can compare against a bill. Nothing in
this repository emits it; `verifiedSavingsUsd` is always `0`.

**Wire transport** — `createCavemanTransport()`: a `fetch` replacement carrying
the request ceiling, exact usage accounting, and provider-native cache hints.
Scales by provider, not by framework.
