# Glossary

Twenty-five terms, each ending in the file that owns it. Everything else in
these docs is explained where it is used.

**Agent directory** — The filesystem-first convention: `instructions.md` +
`agent.ts` + `tools/` + `skills/` + `subagents/`, composed into one ordinary
`agent()` call by `loadAgentDir()`. `packages/agent/src/dir-loader.ts`

**Basis** — The provenance label on a number. `claimBasis` is `inferred` (a
local estimate — the strongest claim any local path here makes), `measured`, or
`verified` (reserved for a system that can compare against a bill; nothing in
this repository emits it). `usageBasis` is `provider_reported` or `unavailable`;
`priceBasis` is `public_catalog` or `unpriced`. `packages/agent/src/run-receipt.ts`

**Breaker** — A deterministic circuit breaker: repeated-tool-call detection,
no-progress windows, per-turn fan-out cap, budgeted retry. No model
participates in any breaker decision. `packages/agent/src/breakers.ts`

**Budget** — A run's declared ceiling in exactly one denomination, `usd` or
`tokens`, enforced by reserve-and-clamp: hold each call's worst case before it
leaves, clamp its output allowance when the remainder cannot fund it, stop
below the floor. A local control, never an invoice. `packages/agent/src/budget.ts`

**Cache epoch** — The window inside which the provider-visible stable prefix
stays byte-stable. A definition, model, or plan change rotates the epoch rather
than replaying stale bytes. `packages/agent/src/runtime.ts`

**Cave Build (lock)** — The immutable proof envelope a successful
`caveman-agent build` writes to `.caveman/agent.lock.json`. It binds canonical
bytes for integrity; it is not a signature or an attestation.
`packages/agent/src/build.ts`

**Compaction capsule** — A `cave.context-summary.v2` replacement for older
context, with typed anchors. A *critical* anchor must survive byte-identically
across generations unless a later user-grounded source supersedes it through an
explicit edge. `packages/agent/src/compaction-api.ts`

**Connect** — The optional client for `cave-connectd`: allowed provider data
behind one stable `connected_data` tool, with exact paginated reads that refuse
rather than silently omit. `packages/agent/src/connect.ts`

**Direct** — The default execution mode: your key, your provider, no proxy. Its
receipt value is `observe-only`. `packages/agent/src/gateway.ts`

**Durable store** — The journal behind a durable run or session:
`DiskDurableStore`, `HttpDurableStore`, `SqlDurableStore`, or
`ObjectDurableStore`. Exclusivity is a lease; a lease this process cannot renew
poisons its appends rather than risking two drivers. `packages/agent/src/durable.ts`

**Effect** — A tool's declared side-effect class: `read`, `write`,
`idempotent`, or `external`. Mandatory in every sandbox mode.
`packages/agent/src/primitives.ts`

**Eval split** — `profile`, `development`, or `holdout`. A build searches on
development, freezes the winner, then opens untouched holdout fixtures.
`packages/agent/src/profile.ts`

**Execution backend** — The seam every coding tool's process and workspace
effects pass through: `localExecutionBackend()` (the host) or
`httpExecutionBackend()` (a remote sandbox speaking three JSON endpoints).
`packages/agent/src/execution-backend.ts`

**Fail closed** — Refusing to produce a value when the evidence for it is
missing, rather than substituting a default. Unknown model, pricing, usage,
grader, runtime, or sandbox state fails closed. `AGENTS.md`

**Memory** — Durable recall scoped to `(tenant, agentId, namespace)`: passive
next-turn retrieval, explicit remember/search/forget, TTL, and reversible
consolidation. Retrieved memory is inferred and possibly stale.
`packages/agent/src/memory.ts`

**Model boundary** — The adapter seam where `prepare(request, context)` returns
a **replacement** request. Home of compaction and model routing.
`packages/agent/src/model-boundary.ts`

**Observability adapter** — A package under `packages/adapters/*` that records
lifecycle and usage from a native framework loop. It does not run a Caveman
agent, and its manifest declares every capability, with unknown support as
`unsupported`. `packages/adapter-kit/src/index.js`

**Observe-only** — The receipt value a direct run carries: the provider's own
base URL, no transform, no gateway telemetry, and no efficiency claim.
`packages/agent/src/gateway.ts`

**Optimized** — The optional mode routed through the local Caveman gateway,
with eligible transforms and content-blind telemetry. Local reductions stay
basis `inferred`. `packages/agent/src/gateway.ts`

**Programmatic mode** — One `caveman_code` tool instead of a JSON tool wall;
the model writes a bounded cell that dispatches nested tools through the
canonical kernel. `packages/agent/src/programmatic-tools.ts`

**Receipt** — `RunReceipt`: per-call, per-tool, and per-subagent breakdown plus
tranches, breakers, compactions, and resume evidence. Returned on success and
carried on `CavemanRunError` after a failure. `packages/agent/src/budget.ts`

**Sandbox mode** — `required` (tool code in an OS-isolated subprocess; fails
closed when containment cannot be verified), `host` (uncontained host
execution, never a synonym for isolation, never lock-eligible), or `fixture`
(trusted test tools in-process with writes blocked; not a security boundary).
`packages/agent/src/definition.ts`

**Session** — One conversation and one `AgentRunController` behind
`/sessions/{id}`. A message during an active run queues onto it; a message
while idle starts the next run on the same conversation.
`packages/agent/src/serve-session.ts`

**Skill** — An Agent Skills-compatible `SKILL.md` under `.agents/skills/`.
Metadata enters the stable prefix; the body loads on demand.
`packages/agent/src/agent-environment.ts`

**Wire transport** — `createCavemanTransport()`: a `fetch` replacement carrying
the request ceiling, exact usage accounting, and provider-native cache hints.
Scales by provider, not by framework. `packages/agent/src/wire.ts`
