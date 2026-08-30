<p align="center">
  <img src="docs/assets/caveman-logo-banner.png" alt="Caveman" width="720">
</p>

<p align="center"><strong>Build agents that can work, remember, recover, and prove what they spent.</strong></p>

<p align="center">
  A TypeScript runtime and profile-guided compiler for tool-using agents.<br>
  One SDK for programmatic tools, durable memory, typed compaction,<br>
  budgets, receipts, crash recovery, eval-gated builds, and framework adapters.
</p>

<p align="center">
  <a href="#license"><img src="https://img.shields.io/badge/license-Apache--2.0-green?style=flat" alt="Apache-2.0"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A522.19-blue?style=flat" alt="Node 22.19+">
  <img src="https://img.shields.io/badge/savings-always_inferred-orange?style=flat" alt="local savings stay inferred">
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#one-tool-instead-of-a-wall-of-tools">Programmatic tools</a> ·
  <a href="#memory-that-does-not-block-the-current-turn">Memory</a> ·
  <a href="#compaction-that-preserves-commitments">Compaction</a> ·
  <a href="#compile-against-evals-not-vibes">Compiler</a> ·
  <a href="#receipts-budgets-and-durable-runs">Operations</a>
</p>

---

Most agent SDKs stop at model calls and tool loops. Caveman also owns context
lifecycle and runtime evidence:

- **Programmatic tools** collapse a large JSON tool surface into one bounded
  `caveman_code` cell while every nested call still passes through canonical
  validation, budgets, breakers, timeouts, aborts, and receipts.
- **Durable memory** provides async next-turn recall, session search, explicit
  remember/search tools, optional embeddings and graph traversal, reversible
  consolidation, TTL, and tenant/agent/namespace isolation.
- **Caveman Connect** exposes allowed provider data through one stable tool;
  OAuth and credentials remain in `cave-connectd`, while exact paginated reads
  fail closed instead of silently omitting context.
- **Typed compaction** preserves current intent, exact critical commitments,
  recent self-contained tool turns, and exact-recovery references under a
  declared token or USD budget.
- **Profile-guided builds** search candidate plans on development evals, freeze
  a winner, and open untouched holdouts. Failed evals never produce a lock.
- **Production controls** meter root and subagent calls into one receipt,
  reserve priced calls before spend, retain partial receipts on failure, and
  resume durable runs from journaled boundaries.

All of this works without a Caveman account. In observe-only mode the SDK calls
your provider directly. Optional local Caveman Engine integration can add
recoverable transforms, but local execution never mints verified savings.

> **Development status:** this README documents current `main`, including
> `@caveman-ai/agent` v0.2 source. That release is not yet published to npm;
> registry installs may expose an older surface. Use this checkout when testing
> capabilities described below.

## Quick start

Requires Node.js 22.19+ and one supported provider credential.

### Try current repository source

```bash
git clone https://github.com/JuliusBrussee/agent-sdk.git
cd agent-sdk
npm ci
npm --prefix packages/pebble-protocol run build
npm ci --prefix examples/coding-agent --ignore-scripts
npm test
```

### Smallest agent

```ts
import { agent, auto, run } from "@caveman-ai/agent";

const support = agent({
  id: "support",
  instructions: "Answer from policy. Never invent policy.",
  model: auto(),
});

const result = await run(support, "Can I get a refund?");
console.log(result.text);
console.log(result.receipt);
```

`auto()` resolves explicit configuration; it does not silently classify tasks
or invent a dynamic routing policy. A machine with Node and a provider key can
run direct to the provider in `observe-only` mode: no transforms, no gateway
telemetry, and no efficiency claim.

Prefer filesystem-first authoring:

```text
support-bot/
├── instructions.md
├── agent.ts
├── skills/
│   ├── refund-policy.md
│   └── shipping-claims.md
├── tools/
│   └── lookup_order.ts
├── subagents/
└── evals/
    └── support.eval.ts
```

```ts
import { loadAgentDir, run } from "@caveman-ai/agent";

const support = await loadAgentDir("./support-bot");
const result = await run(support, "Where is order A-123?");
```

Descriptions for filesystem skills enter stable context. Skill bodies stay on
disk until invoked, so adding a large skill does not expand every request.

## One tool instead of a wall of tools

Programmatic mode gives a coding model one provider-visible tool named
`caveman_code`. Model writes a bounded JavaScript cell and calls nested tools
through typed proxies:

```ts
import {
  createCodingAgent,
  runCodingTurn,
  startCodingSession,
} from "@caveman-ai/agent/code";

const codingAgent = createCodingAgent({
  workspace: process.cwd(),
  toolMode: "programmatic",
});

const session = await startCodingSession(codingAgent);
await runCodingTurn(session, "Find failing tests and fix root cause.");
```

Transport wrapping is automatic. Nested calls still use the runtime's normal
tool dispatcher; code cells do not bypass schemas, effect policy, call limits,
receipts, timeouts, or abort signals. Receipt records both composite cell and
each nested tool call.

Literal `effect: "read"` calls may start while cell source is streaming. Writes,
idempotent or external operations, variable-dependent arguments, and reads
after possible writes never speculate. Set `speculativeToolCalls: false` to
keep programmatic mode without early reads, or `toolMode: "direct"` to expose
ordinary JSON tools.

Programmatic mode currently supports host agents. Its Worker and host tool
execution are not isolation boundaries. Use normal `sandbox: "required"`
agents when containment matters.

Generic embedders can use `createProgrammaticToolRuntime` from
`@caveman-ai/agent/programmatic-tools` without adopting coding-agent helpers.

## Memory that does not block current turn

```ts
import {
  agent,
  auto,
  createMemoryEngine,
  memory,
  run,
} from "@caveman-ai/agent";

const definition = agent({
  id: "support",
  instructions: "Resolve support requests.",
  model: auto(),
  memory: memory({ namespace: "support" }),
});

const engine = createMemoryEngine({
  scope: { tenant: "tenant-1", agentId: "support", namespace: "support" },
  ttlMs: 30 * 86_400_000,
});

await run(definition, "Remember that I prefer email updates.", {
  memory: { tenant: "tenant-1", engine },
});
```

Passive retrieval starts during turn N; completed recall enters turn N+1
without blocking current model. Recalled context appears immediately before
current user message, never inside cache-stable system prefix or permanent
conversation history.

Built-in paths include:

- explicit remember, search, forget, link, and prior-session search;
- dependency-free sparse lexical vectors by default;
- optional explicit embedding adapters and bounded graph expansion;
- optional model-backed extraction, relevance review, and consolidation;
- atomic local storage plus in-memory and custom storage adapters;
- inactive evidence and relation edges for reversible consolidation.

Memory scope is `(tenant, agentId, namespace)`. Obvious private keys, provider
tokens, credential assignments, and access keys are rejected before storage,
indexing, or sidecar processing. Retrieved memory is marked inferred and
potentially stale; code, tools, current user intent, and runtime evidence win.

Full contract: [agent memory](./packages/agent/docs/memory.md).

## Compaction that preserves commitments

Compaction is one stage in a fail-closed budget ladder: exact-recovery eviction,
typed summary, output clamp, then stop.

```ts
import { run, type RunBudget } from "@caveman-ai/agent";

const budget: RunBudget = {
  maxTokens: 120_000,
  onExhausted: "compact",
  compaction: {
    keepRecentTokens: 8_000,
    summaryMaxTokens: 2_048,
    preserveFirstUserMessage: true,
  },
};

const result = await run(support, "Continue investigation.", { budget });
```

`cave.context-summary.v2` uses source IDs, SHA-256 digests, generations, typed
anchors, and transition validation. Runtime rejects a replacement unless it is
smaller and preserves root intent, required user sources, byte-identical prior
critical anchors, and recent self-contained tail. Tool content cannot mint
critical policy. Later user-grounded decisions can supersede earlier ones only
through explicit edges.

Public harness measures transition validity, anchor recall, exact-recovery
coverage, and compression ratio across repeated runs. Structural stability is
tested; semantic superiority is not claimed.

Full contract: [context compaction](./packages/agent/docs/compaction.md).

## Compile against evals, not vibes

```bash
npm run build
```

Checked-in profile evals characterize workload. Candidate plans search on
development cases. Selected plan freezes before untouched holdouts open. No
candidate gets a lock unless declared quality gates pass.

A successful build writes:

- `.caveman/agent.lock.json` — immutable Cave Build proof envelope;
- `.caveman/workload-profile.json` — content-blind profile and provenance;
- `.caveman/build-report.json` — search cost, holdout evidence, claims, and
  break-even point estimate only when required evidence is complete.

Native Pi tool-free agents can search priced model, reasoning effort,
reversible Context IR routes with exact recovery, and output budgets. Generic
framework adapters remain baseline-equivalent unless their capability manifest
proves otherwise. Existing Caveman, OpenTelemetry, or OpenInference trace
envelopes can seed profiling; raw prompt and result attributes are refused.

Build hashes bind canonical bytes for integrity. They are not signatures,
runtime attestation, SBOM provenance, or proof that registered bytes served
production traffic.

## Receipts, budgets, and durable runs

Every successful run returns model calls, tool calls, provider usage basis,
catalog cost basis, stop reason, compactions, retries, subagents, and resume
state. Failure after spend throws `CavemanRunError` with same partial receipt.

USD budgets reserve each priced root or descendant call before provider
traffic, then settle measured public-catalog cost afterward. Unknown model or
price cannot consume an imaginary `$0`; a USD-capped run fails closed. Token
budgets use same root ledger. These are local controls, not provider invoices,
platform quotas, or cross-process financial reservations.

Durable mode journals call intent before network work. Resume restores known
spend and execution boundary. A request in flight during crash remains unknown
because SDK cannot know whether provider billed it; receipt says unknown rather
than guessing.

`stream()` emits typed run, context, model, completion, and error events.
Returning iterator aborts in-flight provider, tool, and subagent work before
conversation ownership releases.

## Safety boundaries

- `sandbox: "required"` fails closed when verified OS containment is
  unavailable. Use WSL2 for required-sandbox production tools on Windows.
- `sandbox: "host"` means uncontained host execution. It is explicit, never a
  synonym for isolation, and cannot hide under a sandbox-required parent.
- Tool and subprocess environments use explicit allowlists, not ambient secret
  inheritance.
- Provider-visible stable prefixes remain byte-stable inside one cache epoch.
- Unknown model, pricing, usage, grader, runtime, or sandbox state fails closed.
- Observe-only mode never claims optimization.

Threat model: [packages/agent/SANDBOX_THREAT_MODEL.md](./packages/agent/SANDBOX_THREAT_MODEL.md).

## Framework adapters

Adapters install separately and pin exact upstream versions:

```bash
npm install @caveman-ai/agent @caveman-ai/adapter-vercel-ai-sdk ai@7.0.43
npm install @caveman-ai/agent @caveman-ai/adapter-mastra @mastra/core@1.55.0
npm install @caveman-ai/agent @caveman-ai/adapter-eve eve@0.29.2
```

Repository includes lanes for Pi, Claude Agent SDK, Vercel AI SDK, Eve, and
Mastra. Shared manifest validates exact capability and lifecycle metadata;
registry performs discovery only. Candidate conformance never grants execution
or mints release certification. Adapter presence never implies behavioral
compiler support or live provider certification.

### Portable optimizations

Adapters carry lifecycle, usage observation, and a model boundary. The
economics — request ceiling, exact accounting, provider-native cache hints —
attach one layer lower, at the provider `fetch`, so they need no per-framework
code and work even where an adapter declares `modelInterception` unsupported:

```ts
import { createAnthropic } from "@ai-sdk/anthropic";
import { createCavemanTransport } from "@caveman-ai/agent/wire";

const caveman = createCavemanTransport({ budget: { maxTokens: 2_000_000 } });
const anthropic = createAnthropic({ fetch: caveman.fetch });
```

Compaction and routing stay on the adapter boundary because they rewrite what
the framework believes it sent. Cache hints stay on the same live-path gate the
native runtime uses. Boundary rationale, current scope, and limits:
[docs/PORTABILITY.md](./docs/PORTABILITY.md).

## Optional workspace compatibility

Core runtime accepts explicit instructions, contexts, tools, and definition
transforms. It never searches for repository files. Products that need coding-
agent interoperability can opt into `@caveman-ai/agent/plugins`:

```ts
import { agent } from "@caveman-ai/agent";
import {
  applyAgentEnvironment,
  loadAgentEnvironment,
} from "@caveman-ai/agent/plugins";

const environment = await loadAgentEnvironment({ cwd: process.cwd() });
const reviewer = applyAgentEnvironment(agent({
  id: "reviewer",
  instructions: "Review requested changes.",
  model: "openai/gpt-5.4",
  sandbox: "host",
}), environment);
```

Optional adapter supports hierarchical `AGENTS.md`, Agent Skills, declarative
Agent Plugins v1, Vercel OpenPlugin, and compatible Claude/Cursor manifests.
MCP, hooks, custom agents, plugin subprocesses, and ambient-secret inheritance
remain disabled.

## Packages

- `packages/agent` — `@caveman-ai/agent` runtime, compiler, memory,
  compaction, programmatic-tool kernel, and optional workspace adapters.
- `packages/adapter-kit` — framework-neutral capability manifests, registry,
  lifecycle validation, and reproducible conformance metadata.
- `packages/adapters/*` — exact-pinned framework integrations.
- `packages/coding-agent` — `@caveman-ai/coding-agent` and `caveman-code` CLI.
- `packages/create-caveman-agent` — zero-runtime-dependency initializer.
- `packages/pebble-protocol` — frozen Apache-2.0 wire and session contract.
  Proprietary Pebble implementation lives outside this repository.
- `packages/shared` — pinned wire schemas and provider-catalog snapshot used to
  regenerate and verify Agent SDK artifacts.
- `internal/agentbench/corpus` — pinned Apache-2.0 deterministic compiler
  replay corpus.

Detailed SDK API: [packages/agent/README.md](./packages/agent/README.md).
Monorepo boundaries: [docs/MONOREPO.md](./docs/MONOREPO.md).

## Develop

```bash
npm ci
npm --prefix packages/pebble-protocol run build
npm ci --prefix examples/coding-agent --ignore-scripts
npm test
npm run license:check
npm run pack:check
```

`npm test` covers generated catalog drift, protocol and adapter contracts,
coding-agent boundaries, package types, runtime/compiler behavior,
programmatic dispatch, environment loading, memory, compaction, deterministic
replay, initializer, and example agent. Restricted macOS sandbox and loopback
tests need host permissions before failures count as product defects.

## Honesty boundary

Costs are public-catalog list-price subtotals, never invoices. Local execution,
replay, compiler output, memory, and compaction evidence stay `inferred`.
SDK publishes no savings percentage. `verifiedSavingsUsd` remains `0` until
real traffic passes separate rollout and ledger gates. Unknown state fails
closed or returns honest zero.

## License

Apache-2.0. See [LICENSING.md](./LICENSING.md).

Anthropic Claude Agent SDK dependency remains governed by Anthropic terms; see
adapter README and sandbox threat model for exact boundary.
