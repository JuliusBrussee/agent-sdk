# `@caveman-ai/agent`

> **Build anywhere. Compile with Caveman.**

`@caveman-ai/agent` now includes one-command profile/build proof flow:

```bash
npm run build
```

No prior traces required. Build runs declared `profile` evals, searches on
`development`, freezes selected plan, then opens untouched `holdout`. If
content-blind Caveman RunResult, OpenTelemetry, or OpenInference rows already
exist under `.caveman/traces/`, same command imports them and skips profile-eval
spend. No Caveman account required.

Successful split-role v0.2 build writes:

- `.caveman/agent.lock.json` — native Pi behavioral or generic/external baseline
  Cave Build v3 proof envelope;
- `.caveman/workload-profile.json` — content-blind profile and provenance;
- `.caveman/build-report.json` — search cost, holdout evidence, passes, claims,
  and local/inferred point-estimate `break_even_tasks` when total actual search
  cost is complete and holdout catalog delta is positive (`null` otherwise).

Exact first-party native Pi (`tool-free-v1`) owns candidate generation and both
`runAgentInternal` eval runners. For agents with no declared tools it can select
a priced model, lower reasoning effort, add reversible Context IR routes with
derived recovery, and lower output budget. Required semantics and sorted passes
must exactly match the plan diff. Any root tool—including a subagent—refuses
before runner spend. Generic/custom Pi, Vercel AI SDK, Eve, and Mastra remain
baseline-equivalent with empty capabilities and only
`profile_guided_selection`. Claude Cave Build compilation and registration
refuse. Every failure aborts; embedded baseline pointer is manual recovery,
never automatic second paid attempt. Evidence is local `inferred` or registered
client-declared; verified savings remain `$0`. Publish no savings percentage.
Build, compiler, and adapter-contract hashes bind canonical bytes for integrity;
they are not signatures, binary/SBOM provenance, runtime attestation, or proof
that registered bytes served traffic.

Minimal eval file declares independent lineages. Invoking `npm run build`
executes every declared fixture within configured search budget; SDK adds no
approval or permission gate.

```ts
import { eval as defineEval } from "@caveman-ai/agent";

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
export const developmentB = defineEval({
  id: "development-b", lineageId: "development-family-b", split: "development",
  input: "second development task",
  quality: [{ type: "exact_match", expected: "second result" }],
});
export const holdout = defineEval({
  id: "holdout-a", lineageId: "holdout-family-a", split: "holdout",
  input: "unseen representative task",
  quality: [{ type: "exact_match", expected: "expected result" }],
});
export const holdoutB = defineEval({
  id: "holdout-b", lineageId: "holdout-family-b", split: "holdout",
  input: "second unseen task",
  quality: [{ type: "exact_match", expected: "second result" }],
});
```

Optional trace row envelope is deliberately tiny; `trace` may be RunResult,
OTel span, or OpenInference span. Raw prompt/result span attributes are refused.
Generic OTel/OpenInference spans always remain unpriced; only strict Caveman
evidence can be repriced from pinned public catalog.

```json
{"schema_version":1,"case_id":"case-a","lineage_id":"family-a","input_sha256":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","agent_sha256":"abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789","trace":{"traceId":"...","spanId":"...","attributes":{}}}
```

Advanced exact-native programmatic API uses the compiler-owned runner:

```ts
import {
  compileProfiledNativePi,
  createCompilerWorkloadProfile,
  normalizeTrajectory,
} from "@caveman-ai/agent";

const profile = createCompilerWorkloadProfile([
  normalizeTrajectory(profileRun, {
    split: "profile", caseId: "case-1", lineageId: "family-1",
    inputSha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  }),
]);

const result = await compileProfiledNativePi({
  ...nativeCompilerInput, // agent, Context IR, baseline, policy, and digests
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
`compileProfiled` remains the generic caller-owned-runner API and emits
baseline-equivalent v3 only.

Release status: v0.2 reference slice is implemented in this repository but is
non-release and not published to npm. Registry commands below require local
tarballs until `@caveman-ai/agent` and `create-caveman-agent` publish.

Standalone authoring API remains optional convenience. Define instructions,
tools, context, evals, and budgets in TypeScript; Caveman runs agent, reports
provider usage, and produces v3 whenever evals declare split roles.
Unsplit legacy eval suites continue producing Pi Cave Build v2.

Local Caveman Engine is optional. With Engine running, eligible context can use
recoverable local compression. Without it, SDK calls provider directly in explicit
observe-only mode: no transforms or Caveman gateway telemetry. Provider usage and
local context estimates remain available.

## Connect provider data without prompt bloat

```ts
import { agent, auto, createConnect } from "@caveman-ai/agent";

const data = createConnect({
  sources: [{
    id: "work-github",
    provider: "github",
    collect: ["issues"],
    models: ["Issue"],
  }],
});

export default agent({
  id: "issue-triage",
  instructions: "Use connected source data. Never invent missing records.",
  model: auto(),
  tools: [data.tool],
});
```

Run `caveman-agent connect github` once, then `await data.collect()` from app or
deployment job. One stable `connected_data` schema enters model context;
provider catalog, sync/action schemas, and records load only on demand.
Paginated reads never silently summarize or skip records: capped output returns
`complete: false`, exact continuation when available, and `must_refuse: true`.

Full cost, quality, security, and evidence contract:
[`docs/connect.md`](docs/connect.md).

## Quick start

Requires Node.js 22.19+ and one supported provider credential.

```bash
npm create @caveman-ai/agent@latest my-agent
cd my-agent
npm run dev
```

Two commands, no Caveman account or hosted Caveman service. Provider credential
and network still required. On machine that has never seen Caveman, first run
looks like this:

```console
$ npm create @caveman-ai/agent@latest my-agent
$ cd my-agent && npm run dev

  cave: observe-only — engine/gateway unavailable; transforms and gateway
  telemetry off (provider usage and local context estimates remain available)

  agent > what does src/index.ts export?
  … model answers through your own provider credential, direct to the provider …
```

`npm run dev` auto-starts local Cave Runtime when installed. When unavailable,
run uses **observe-only** mode: provider's own base URL, no transform, no gateway
telemetry, and `RunResult.mode: "observe-only"`. Provider usage and local context
estimates remain available; no efficiency result is claimed. To enable Engine:

```bash
npm i -g @caveman-ai/cli && caveman start
```

Then same commands can run `mode: "optimized"`, routed through local gateway with
eligible transforms and context telemetry. Gateway proxies `anthropic`, `openai`,
and `google`; other providers go direct and report `observe-only`. Set `cave:
"off"` in `RunOptions` to choose observe-only. Run carrying Cave Build lock or
candidate plan refuses silent downgrade with
`cave_gateway_required_for_locked_plan`.

Framework accepts loopback runtime only when health identity, run state, PID, and
executable ownership validate. Unrelated local listener never receives provider
traffic; run goes direct in observe-only mode. Local results remain `inferred`;
verified savings stay `$0` until active production traffic passes separate rollout
and ledger gates.

Run a zero-provider-call readiness check before first use or deployment:

```console
$ npx caveman-agent doctor          # add --json for the machine-readable report
PASS node         Node 22.19.0
PASS sandbox      tool sandbox containment probe passed
WARN engine       Caveman engine not found — transforms disabled (observe-only)
WARN runtime_cli  Caveman runtime CLI unavailable — runs stay observe-only
WARN gateway      gateway not reachable at 127.0.0.1:8787 — telemetry off
...
run mode: observe-only (no transforms or gateway telemetry)
next: npm i -g @caveman-ai/cli && caveman start
```

Missing Engine, runtime CLI, or gateway is WARN and exits 0 because observe-only
runs still work. Node version, broken sandbox containment, invalid config, or lock
drift fails check. Doctor also checks engine registry, gateway reachability,
project/config load, Context IR, and provider selection.

Harnesses report separately. Exact native Pi owns `runAgentInternal` candidate
and locked execution and may emit the closed behavioral plan above. Generic
compiler harness accepts adapter-owned runners and binds identity/evidence around
unchanged baseline. Framework-native Vercel and Mastra integration lives only in
their adapter packages; core carries no second host implementation.
Direct `runClaudeAgent` remains unlocked, and every Claude v3 compile refuses
pending source, budget, recovery, cache, and replay evidence.

Context compaction uses the public, modular `@caveman-ai/agent/compaction`
surface. See [`docs/compaction.md`](docs/compaction.md) for runtime setup,
capsule validation, deterministic stability tests, and live-model adapters.

Adapter frameworks ship as separate exact-pinned packages; install only lane used:

```bash
npm install @caveman-ai/agent @caveman-ai/adapter-vercel-ai-sdk ai@7.0.84
npm install @caveman-ai/agent @caveman-ai/adapter-mastra @mastra/core@1.63.2
npm install @caveman-ai/agent @caveman-ai/adapter-eve eve@0.29.2
```

Eve 0.29.2 requires Node.js 24+. Base SDK, Vercel, and Mastra lanes keep package
minimum Node.js 22.19. Each adapter owns and tests its exact upstream pin.

## Smallest agent

```ts
import { agent, auto } from "@caveman-ai/agent";

export default agent({
  id: "support",
  instructions: "Answer from policy. Never invent policy.",
  model: auto(),
});
```

`auto()` selects configured/default model. Resolution order is `CAVE_MODEL`,
`.caveman/provider.json`, then baseline model for the sole supported provider
credential. It never classifies tasks or routes between models.

Run agent from code:

```ts
import support from "./agent.js";
import { run } from "@caveman-ai/agent";

const result = await run(support, "Can I get a refund?");
console.log(result.text);
console.log(result.contextBill);
```

Embed one locked Pi Cave Build after deployment freshness gate:

```ts
import { readFile } from "node:fs/promises";
import { runLocked } from "@caveman-ai/agent";
import { parseAnyCaveBuildLock } from "@caveman-ai/agent/build";
import support from "./agent.js";

// Deployment/startup first runs: caveman-agent check caveman.config.ts
const build = parseAnyCaveBuildLock(JSON.parse(
  await readFile(".caveman/agent.lock.json", "utf8"),
));
const result = await runLocked(support, "Can I get a refund?", build, {
  durable: { runId: "case-42-analysis-1" },
  budget: { maxTokens: 12_000, onExhausted: "stop" },
});
```

`runLocked()` accepts only Pi locks. Before provider traffic it validates lock
integrity, exact agent definition, runtime, adapter/upstream, catalog, Context
IR, selected plan, and live Engine registry when transforms exist. Durable
journal identity includes build and plan digests, so same run ID cannot replay
under another build. Source/config/eval freshness is project-level state and
remains `caveman-agent check` deployment/startup gate; parsing lock alone does
not establish freshness.

That run works on a machine with nothing but Node and a provider credential. It
returns `mode: "observe-only"` there — direct to the provider, no transform, no
gateway telemetry. Provider usage and local context estimates remain available.
With the Caveman runtime installed and started the same call returns
`mode: "optimized"`.

`usageBasis` covers provider-reported aggregate usage. Reasoning breakdown has
its own `reasoningUsageBasis`: when reasoning-capable Pi models omit that
optional split, unlocked runs label it unavailable, while Cave Builds and
subagent accounting fail closed instead of treating missing as zero.

`RunOptions.maxCostUsd` sets a best-effort local spend cap for one run, in USD
at public catalog list prices. It is not financial enforcement: no provider
invoice, platform quota, or cross-process reservation is involved. When set,
every root and descendant model call reserves the catalog worst-case price of
that call against the cap before the request and settles measured catalog cost
after it. Exhaustion ends the run with `cave_run_cost_budget_exceeded` before
the next model call; emitted records stay, and no `run_end` result is produced.
A model the public catalog cannot price cannot be capped: with the cap set, such
a call fails closed instead of consuming $0 of budget. Leave the cap unset for
runs on unpriced models and bound them by declared call ceilings.

Use `stream()` for typed run, context, Pi, completion, and error events.
Calling iterator `return()` aborts in-flight provider/tool/subagent work before
conversation ownership releases. Terminal `run_end` and `run_error` events
release ownership before delivery, so manual consumers cannot strand session.
Both terminal events carry the ledger: `run_error.receipt` is the partial
receipt of what was spent before the failure, and the promise entry points
throw a `CavemanRunError` whose `receipt`/`cause` carries the same — a run that
fails after spending never loses its per-call breakdown. Every model call is
capped by `RunOptions.maxModelCalls` (and tool calls by `maxToolCalls`, each
default 64); reaching the model ceiling ends the run gracefully with
`stopReason: "call_budget_exhausted"`, not a throw.
For explicit multi-turn code, create one conversation and reuse it:

```ts
import { createConversation, run } from "@caveman-ai/agent";

const conversation = createConversation();
await run(support, "My order is late.", { conversation });
const followUp = await run(support, "What should I do next?", { conversation });
```

`npm run dev` does this automatically. Dev reuses one immutable staged copy of
complete project-relative source graph until watched project source, config,
eval, or file context changes. Reload then replaces snapshot while successful
conversation history remains local to parent process. Executed definition,
sandboxed tools, declared root/child file sources, and Cave Build identity all
use same snapshot.
Definition, model, or plan changes rotate cache epoch without replaying stale
prefix bytes. Failed turns roll back conversation/cache state, and concurrent
use of one conversation fails closed. Restarting command starts fresh ephemeral
session. Installed package code remains pinned and cached. Node ESM cannot tear
down timers or listeners created by old module graph after hot reload: keep agent
module top level side-effect-free, or restart dev command after editing module
that owns process resources.

Programmatic agents with tools and default `sandbox: "required"` must pass
`RunOptions.entryPath`, pointing to module that exports agent definition. CLI
supplies this automatically. Before provider traffic, framework copies complete
project source graph into per-run immutable staging, imports tools only from that
snapshot, and tears staging down when stream settles. Framework refuses to run
such tools in-process. Trusted tests may opt into `sandbox: "fixture"`.

Native Windows supports ordinary agent runs, runtime/engine startup, and explicit
`sandbox: "host"` coding tools through `cmd.exe`. `sandbox: "required"` remains
fail-closed on native Windows because package has no verified OS network-isolation
boundary there; use WSL2 for production sandboxed tools. `doctor` reports exact
`cave_sandbox_os_network_isolation_unavailable` failure and WSL2 remedy. Never
replace required sandbox with fixture mode in production.

`sandbox: "host"` is the third mode, for interactive and coding agents whose
tools need real host access. It is explicit opt-in and never a default: closures
run in this process with no tool worker and no `entryPath` requirement, and
`effect: "write"` tools execute instead of being blocked. Effect declarations
stay mandatory — host mode changes enforcement, not declaration. A host-mode
agent may not sit under a sandbox-required ancestor, so a subagent cannot use it
to leave its root's containment. Live host runs are never lock-eligible: an
unsandboxed run cannot produce a lock, so `compile` refuses a host-mode agent
with `cave_host_sandbox_lock_ineligible` before any search run. Locked builds
for coding agents compile against fixture corpora with a contained sandbox mode
instead.

## Claude Agent SDK

Use same agent definition through exact-pinned Claude Agent SDK lane:

```ts
import { runClaudeAgent } from "@caveman-ai/adapter-claude-agent-sdk";
import { fileURLToPath } from "node:url";
import support from "./agent.js";

const result = await runClaudeAgent(support, "Can I get a refund?", {
  entryPath: fileURLToPath(new URL("./agent.js", import.meta.url)),
  maxTurns: 8,
  maxBudgetUsd: 0.50,
});
```

Public lane is always unlocked and returns `claimBasis: "inferred"` with
verified savings `$0`. It disables Claude built-in tools and settings, maps
declared read+inline Caveman tools into one in-process MCP server, reuses same immutable
source snapshot and sandbox executor as Pi, enforces declared model/reasoning/
output schema, and sends requests through Caveman Anthropic proxy. Memory and
framework subagents fail closed in Claude lane until equivalent semantics exist.
Write/idempotent/external tools and `auto`/page/compress/CCR results also reject
before SDK/tool execution; this prevents side effects followed by unavailable
recovery. Framework strips inherited `x-cave-*` headers before adding its own
content-blind, explicit-pass-through metadata.
Caller cannot inject Cave Plan or Cave Build identity.
Public lane defaults to 16 turns. `maxTurns` and `maxBudgetUsd` set explicit SDK
caps; declared `output({ maxTokens })` becomes SDK task token budget and a
terminal provider-usage ceiling. Reasoning is model-capability aware: Haiku 4.5
uses fixed manual thinking with no `effort`; known adaptive models use adaptive
thinking plus declared effort; unknown capabilities fail before provider spend.
Manual thinking requires `maxTokens` above its 1,024/4,096/8,192-token
low/medium/high budget. Pinned Agent SDK reports aggregate output tokens but no
authoritative thinking-token split, so results expose
`reasoningUsageBasis: "unavailable"`; `reasoningTokens: 0` is a non-evidence
placeholder and must not be read as measured zero.

`@anthropic-ai/claude-agent-sdk` and `zod` are optional peers, not dependencies:
they are reachable only through `@caveman-ai/agent/claude`, so a default install
never downloads them. Using that subpath means installing them yourself:

```bash
npm install @anthropic-ai/claude-agent-sdk@^0.3.220 zod@^4.4.3
```

`caveman-agent doctor` reports which optional lanes this installation can reach
and prints the exact install command for any that are missing, so an absent peer
surfaces before a run instead of as `ERR_MODULE_NOT_FOUND`.

Package pins `@anthropic-ai/claude-agent-sdk` 0.3.220 and Claude Code 2.1.220
identity. Anthropic SDK is not open source; its README points to Anthropic
Commercial Terms and describes data collection. Framework source remains
Apache-2.0, but users of
Claude lane must review Anthropic terms and data policy.

## Tools

Tool input, output, side effect, timeout, and result policy are explicit:

```ts
import { schema, tool } from "@caveman-ai/agent";

const lookupPolicy = tool({
  name: "lookup_policy",
  description: "Read current refund policy.",
  input: schema.object({ region: schema.string() }),
  output: schema.object({
    region: schema.string(),
    refundWindowDays: schema.number(),
  }),
  effect: "read",
  result: "auto",
  async execute({ region }) {
    return { region, refundWindowDays: 14 };
  },
});
```

`input` also accepts Standard Schema v1. Schemas implementing Standard JSON
Schema v1 convert automatically to draft-07 provider schema. Validation-only
Standard Schema libraries pass explicit `inputJSONSchema`; framework still runs
schema validator before tool code, including async validation and transforms.

`output` accepts TypeBox/JSON Schema or Standard Schema v1. Standard JSON
Schema v1 converts automatically with its `output` direction. Validation-only
Standard Schema libraries pass explicit `outputJSONSchema`. Output validation
runs after tool code but before any result can enter model context or durable
settlement; mismatch becomes tool error and raw invalid value stays hidden.
Declared results serialize from same immutable validated snapshot and ignore
prototype `toJSON` hooks. Schema-less tools retain native JSON serialization for
backward compatibility.

Standard Schema validators and TypeBox `format` checks can close over mutable
runtime state. Ordinary runs support them, but Cave Build locks and durable runs
refuse opaque validator identity. Supply `schemaSemanticsSHA256` as lowercase
SHA-256 of validator code, dependencies, and captured state; change digest when
any semantic input changes. Receiver-state drift detectable after `tool()`
construction fails validation.

Effects: `read`, `write`, `idempotent`, `external`.

### Optional workspace compatibility

Core definitions accept explicit instructions, contexts, and tools. Runtime does
not search workspaces. Optional `@caveman-ai/agent/plugins` compatibility supports
repository instructions, standard Agent Skills, Agent Plugins v1, and Vercel
OpenPlugin packages:

```ts
import {
  applyAgentEnvironment,
  createAgentEnvironmentTransform,
  expandAgentEnvironmentSlashCommand,
  loadAgentEnvironment,
} from "@caveman-ai/agent/plugins";
import { agent } from "@caveman-ai/agent";
import { createCodingAgent } from "@caveman-ai/agent/code";

const environment = await loadAgentEnvironment({ cwd: process.cwd() });
const definition = applyAgentEnvironment(agent({
  id: "reviewer",
  instructions: "Review requested changes.",
  model: "openai/gpt-5.4",
  sandbox: "host",
}), environment);
const prompt = expandAgentEnvironmentSlashCommand(
  "/vercel-plugin:deploy preview",
  environment,
);
const coding = createCodingAgent({
  workspace: process.cwd(),
  toolMode: "programmatic",
  definitionTransforms: [createAgentEnvironmentTransform(environment)],
});
```

Loader scans project then user `.agents/skills/<name>/SKILL.md`, and discovers plugins under
`.agents/plugins/<plugin>`. Both Agent Plugins v1 root `plugin.json` and
OpenPlugin `.plugin/plugin.json` manifests work; Claude and Cursor compatibility
manifests are accepted too. Explicit roots are available for product wrappers.
Plugin skills and commands use qualified IDs such as `vercel-plugin:nextjs` and
`vercel-plugin:deploy`. Metadata enters stable prefix; full SKILL.md, contained
resources, and markdown command bodies enter model context only after activation.
`$ARGUMENTS` and `$1` through `$9` expand for plugin commands. Coding products
can pass `createAgentEnvironmentTransform(environment)` through
`definitionTransforms`; programmatic mode then nests loader behind its one
composite tool without making workspace discovery a core runtime concern.

Agent Plugins v1 and OpenPlugin support currently implements declarative skills
and markdown commands. `mcp.json`/`.mcp.json`, hooks, and custom-agent presence
is reported but not launched. SDK does not inherit ambient secrets or execute
plugin subprocesses.

### Programmatic tools and speculative reads

Coding sessions need one option; transport wrapping is automatic:

```ts
import {
  createCodingAgent,
  runCodingTurn,
  startCodingSession,
} from "@caveman-ai/agent/code";

const agent = createCodingAgent({
  workspace: process.cwd(),
  toolMode: "programmatic",
});
const session = await startCodingSession(agent);
await runCodingTurn(session, "inspect failures and fix root cause");
```

Programmatic mode replaces ordinary provider-visible tools with one bounded
`caveman_code` cell. Nested calls still pass through runtime's canonical tool
budget, breaker, validation, receipt, timeout, and abort path; receipts expose
both composite call and each nested call. Complete literal `effect: "read"`
calls may start while model streams cell source. Writes, idempotent operations,
external calls, variable-dependent arguments, and reads after possible writes
never speculate. Set `speculativeToolCalls: false` to retain programmatic mode
without early reads, or `toolMode: "direct"` for ordinary JSON tool calls.

Declaring `effect: "read"` in this mode means work is safe to start and abandon:
it may run even when generated cell is later discarded. Unknown or ambiguous
stream provenance executes fresh work instead of reusing stale speculation.
Programmatic mode supports host agents only. Host execution and code-cell Worker
are not isolation boundaries; use normal required-sandbox agents when containment
is needed. Generic host-agent embedders can use
`createProgrammaticToolRuntime` from `@caveman-ai/agent/programmatic-tools`.

Result policies:

- `auto` lets locked plan choose inline, paging, compression, or exact CCR.
- `inline` keeps result in current context.
- `page` exposes bounded pages.
- `compress` uses eligible locked transform.
- `exact_ccr` replaces only after byte-exact recovery is stored.

Production tools run in a restricted subprocess under an OS network boundary —
a network namespace on Linux (`unshare --net`), `sandbox-exec (deny network*)`
on macOS — so egress is blocked at the kernel, not by in-process monkeypatching
(which is defense-in-depth only and cannot be a boundary). `sandboxProfile.network:
true` is not a way to allow egress: it requests UNBOUNDED egress and fails closed
with `cave_sandbox_network_egress_unbounded`, because there is no scoped-egress
mechanism yet (a parent-owned CONNECT proxy is the tracked follow-up). See
`SANDBOX_THREAT_MODEL.md` for the per-platform boundary and its known gaps (notably
Linux unix-domain sockets, which a network namespace does not cover). A live
profile may request only one
runtime-owned provider capability: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or
the Google capability (`GEMINI_API_KEY` and `GOOGLE_API_KEY` are aliases).
Signing, deployment, bootstrap, database, cloud, loader, and ambient
environment names are categorically denied, and the child starts from a fixed
baseline (`LANG`, `LC_ALL`, `PATH`, `TZ`, and the fixture marker) rather than a
spread of the parent environment. Host filesystem stays restricted to staged
source plus ephemeral workspace.
Child-process permission fails closed until OS-level descendant containment is
portable and verifiable.
Framework subagents may use normal tools and delegate further subagents. CLI
passes one root entry automatically; programmatic runs pass `entryPath` once at
root. Framework keeps descendant route private, verifies root and selected-tool
definition digests after sandbox re-import, then executes exact child tool in
restricted subprocess. Descendant model calls reserve catalog-priced
worst-case spend against every ancestor `maxCostUsd` cap before provider call;
every turn must report complete usage and exact requested provider/model.
`cave_` tool names remain reserved for framework recovery and memory tools.

## Context, memory, output

```ts
import { context, file, memory, output, schema } from "@caveman-ai/agent";

const playbook = context({
  id: "support.playbook",
  kind: "skill",
  source: file("./support.md"),
  stability: "build",
  safety: "S0",
  priority: "required",
});

const supportMemory = memory({
  namespace: "support",
  ttl: "30d",
  recallBudget: 1_200,
  consent: "local_only",
});

const answer = output({
  maxTokens: 500,
  schema: schema.object({ answer: schema.string() }),
});
```

Build-stable context enters frozen prefix. Session and turn context stay live.
Runtime rejects volatile data in stable cache zone and fails open to original
provider-visible bytes on drift or transform failure. Cave Build binds static
Context IR only; eval inputs, user turns, history, and tool results remain
runtime evidence and never make lock depend on one fixture prompt.

`memory()` defaults to `ttl: "30d"`, an 800-token recall budget, and ambient
policy. Coding agents and Pebble need one option: `memory: true`. They create one
durable tenant/agent/namespace-scoped engine and reuse it across turns. Generic
agents pass reusable engine through `RunOptions.memory`. One-shot run without
one keeps explicit tools only and never leaves background work alive.

Passive recall is asynchronous: turn N starts retrieval while main model runs,
then turn N+1 consumes ready results without waiting. Retrieved memory enters
live context immediately before current user turn, never stable system prefix or
append-only conversation history. `cave_memory_remember`, `cave_memory_search`,
and `cave_memory_session_search` provide explicit store, recall, and prior-turn
RAG paths.

Default retrieval uses dependency-free sparse cosine plus lexical ranking. It is
not claimed semantic. `@caveman-ai/agent/memory` exposes compact vector, graph,
storage, embedding, workflow, and sidecar adapters. Semantic embedding and
model-backed extraction/relevance/consolidation run only when explicitly
supplied; no hidden per-turn model call exists. See
[`docs/memory.md`](docs/memory.md).

Local persistence stays private per-namespace JSON written with atomic
temp-write + rename. Vectors are normalized int8/base64, not floating-point JSON
arrays. Expired records become inactive reversible evidence. Recalled memory
stays basis `inferred` — nothing here is ever a saving.

Entries are keyed by **(tenant, agentId, namespace)**, so two `AgentDefinition`s
declaring the same namespace in one process never see each other's memories, and
an embedding server isolates tenants. `RunOptions.memory` controls where and for
whom: `root` (default `CAVE_AGENT_MEMORY_ROOT`, else `~/.caveman/agent-memory`)
points at your own location, and `tenant` (default single-tenant) scopes per
tenant. Only `provenance: "local"` + `consent: "local_only"` are supported — a
shared-backend config is refused at `memory()` construction, never at tool-call
time. In-process writes are serialized per file; across processes atomic rename
prevents torn files, with last-writer-wins on concurrent update. Server
deployments needing multi-writer transactions supply storage adapter.

## The coding agent (`@caveman-ai/coding-agent`)

The new caveman-code: an interactive coding agent built on this framework, with
host-sandbox `read_file` / `grep` / `bash` / `write_file` / `edit_file` tools
over one workspace. `read_tool_output` pages or literal-searches large captured
results without repeating the original command. It is the successor to the
deprecated `caveman-code` fork.

```ts
import { createCodingAgent, runCodingSession } from "@caveman-ai/coding-agent";

const agent = createCodingAgent({ workspace: process.cwd() });
await runCodingSession({ agent });
```

**Optimized by default, observe-only loudly.** With the Caveman engine present,
the session starts the local Cave runtime and runs with a default efficiency
plan: one recoverable route per live-zone segment kind — `tool_result` through
`caveman.engine.terminal.v1`, `history` through `caveman.engine.text.v1` — with
`cave_retrieve` registered so the model can pull exact original bytes back. Only
CCR-recoverable transforms are eligible; `toon` is forced-only and never routed
by default, and no lossy-without-recovery class enters a default plan. One route
per kind is deliberate: two routes matching one runtime segment collapse into
`dynamic_route_ambiguous` and the segment passes through untouched.

When the runtime cannot be reached, the session degrades to observe-only — but
never silently. It prints the banner (engine/gateway unavailable, transforms and
gateway telemetry off, provider usage and local context estimates still available,
`npm i -g @caveman-ai/cli && caveman start`), records it on
`session.notices`, and shows the mode on the prompt and in every turn's bill. A
turn that carries a plan refuses to degrade on its own: it throws
`cave_gateway_required_for_locked_plan`, and only that failure earns one retry
without the plan. The runtime is probed once per session, not once per turn:
the answer is pinned on the session, so a machine with no runtime pays one
failed start attempt for the whole session, and once a session has degraded it
stays degraded.

**The token bill is a token count.** After every turn the session prints context
tokens before and after transforms (from `RunResult.transformTrace`), tokens
saved labelled `inferred (local estimate)`, provider usage with its
`usageBasis`, and spend in USD with its `priceBasis`. Savings are never
expressed in currency, and a local session mints nothing — verified savings are
platform evidence, not something a laptop can produce.

**Recovery is proved, not asserted.** `/prove-recovery` (and one automatic line
after the first compression) takes a recorded tool output, runs it through the
same engine compress/retrieve pair the plan and `cave_retrieve` use, and reports
the sha256 comparison:

```
recovery proof: read_file:big.txt round-trip OK (sha256 match efac7be09c1a)
```

Mismatches print as `FAILED (sha256 mismatch)`; the plan falls back to the
original body. Tool output is capped **before** compression (24 KB for
`read_file` and `bash`, 16 KB for `grep`, all under the runtime's inline
tool-result ceiling), so a runaway command cannot blow the context even with no
engine installed. Large captured results receive active-agent opaque handles;
`read_tool_output` retrieves a byte page or literal match. Bash keeps the tail,
where compiler and test failures normally land. Captured results are bounded to
8 MiB each and 16 MiB total in memory; handles expire with the process or
oldest-entry eviction.

Coding turns enable deterministic repeated-call, no-progress, and fan-out
breakers by default. `CodingSessionOptions.budget` exposes the runtime's hard
pre-call token/USD budget; USD and `maxCostUsd` remain mutually exclusive and an
unpriced model still fails closed.

Matched harness evaluations can call `summarizeCodingTaskAttempts()`. Its
`costPerCompletedTaskUsd` is total spend across every attempt — failures
included — divided by externally verified completions. Missing completion,
price, or stable runtime identity makes that cost metric `null`; missing usage
makes token metrics `null`. Unknown evidence never becomes a favorable zero,
and provider-invoice/public-catalog price bases cannot be mixed.

`@caveman-ai/agent/code` remains a compatibility export during package
extraction. New applications should import `@caveman-ai/coding-agent`; new
coding-product code belongs in that package boundary.

Live coding sessions are never lock-eligible: host mode makes `compile` refuse
with `cave_host_sandbox_lock_ineligible`, so nothing a session does becomes a
Cave Build. Runnable example: [`examples/coding-agent`](../../examples/coding-agent).

## Deploy

`caveman-agent serve` is the deployable target: one agent directory behind
`POST /runs` + `GET /runs/{runId}` + `/healthz` + `/readyz`, with every run
journaled. `runId` is the caller-assigned idempotency key, so resubmitting a
settled run replays its journaled outcome and spends nothing.

```bash
CAVE_SERVE_TOKEN=$(openssl rand -hex 24) caveman-agent serve
```

`/runs` has no unauthenticated mode; it spends money and returns model output.

Durability is the journal's, not the server's. The server adds an idempotent
submit, recovery (on boot AND every 60s, so a run stranded by a peer
instance's death is reclaimed rather than waiting for a redeploy), and a
SIGTERM drain that is best effort by design — unfinished runs stay journaled
and the next instance resumes them. The guarantee remains at-least-once at the
step boundary, and the uncertainty window is on the receipt as
`resume.possibleDoubleCountCalls`, never silent.

The deployable unit is a container, because the runtime shells out for
host-sandbox tools. [`hosting/`](hosting/README.md) ships the Dockerfile and a
complete Cloudflare recipe: the agent in a Container, the journal in a Durable
Object — Workers has no `node:child_process`, and container disk does not
survive the instance. On any platform, two things decide whether the deployment
is actually durable: the journal must outlive the instance (a volume at
`/app/.caveman`, or `CAVE_JOURNAL_URL` pointing at an `HttpDurableStore`
endpoint), and health checks must distinguish `/healthz` from `/readyz`.

## Evals and Cave Build

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

```bash
npm run build
npm run check
```

Legacy unsplit Pi v2 build performs finite search with five seeds per declared
fixture. Split-role v3 uses optional content-blind profile traces (or declared
profile evals), selects exact-native Pi candidates on `development`, freezes the
winner, then opens untouched `holdout`. Native plan cost may not exceed baseline
in either split. Generic/custom Pi, Vercel AI SDK, Eve, and Mastra v3 builds
remain baseline-equivalent. Preflight prints static one-call reservation
estimate, not full multi-turn ceiling; terminal provider overage remains visible
and remaining max-cost budget hard-stops new candidate calls. No v3 proof envelope
is written when usage is missing, model is unpriced, cache regresses,
recovery fails, sandbox/privacy fails, quality drops, search is incomplete, or
cost ceiling is exceeded. `check` rejects drift before model call.
Legacy v2 successful build output names selected model, reasoning, transform routes,
baseline and selected public-catalog cost per task, inferred percentage change,
and completed eval evidence before printing lock identity.
Public `run()` cannot inject a plan or build identity. `npm run dev`, `build`,
and `check` own validated Cave Build execution. Locked/candidate execution checks
selected provider, model, and reasoning before provider traffic. Every provider
turn must return exact provider/model identity and arithmetically complete usage;
framework recomputes cost from public catalog.

Advanced build config lives in `@caveman-ai/agent/build`. Framework integrations
ship as `@caveman-ai/adapter-pi`, `@caveman-ai/adapter-claude-agent-sdk`,
`@caveman-ai/adapter-vercel-ai-sdk`, `@caveman-ai/adapter-eve`, and
`@caveman-ai/adapter-mastra`. `@caveman-ai/agent/claude`,
`@caveman-ai/agent/adapters`, and `@caveman-ai/agent/code` remain compatibility
exports for generic harness and legacy Pi/Claude/Eve bindings. Vercel and Mastra
host integration is not duplicated there. Each compiler harness run requires a Cave Build whose harness,
adapter version, upstream version, selected plan, and Context IR match before
provider execution. Runtime result must then carry terminal text, actual response
model identity, complete provider usage, transform/recovery evidence, and a
public-catalog-priced model. Those are caller/output integrity checks around the
unchanged baseline plan, not adapter behavior lowering. No generic v3 adapter
currently constructs or binds changed model, reasoning, context,
transform, recovery, retry, or output-budget behavior from compiler output.
Exact native Pi uses a separate compiler-owned `runAgentInternal.lockedBuild`
path that materializes its closed selected plan. Each
third-party adapter recomputes cost; local result stays
`inferred` with verified savings `$0`.

Legacy Eve compatibility accepts exact-pinned `ClientSession` 0.29.2. Eve aggregates
durable `step.completed` usage and verifies `session.started` runtime identity;
because Eve 0.29.2 omits reasoning-token usage, only `reasoning: "none"` Cave
Builds execute there. Dynamic Eve model identity, model drift,
missing usage, terminal failure, unpriced models, and version drift reject.

A Pi lock can never authorize Claude or third-party execution. Adapter identity
requires explicit built-bundle and dependency-lock SHA-256 values; function
source text is never artifact identity. Shared execution kernel owns
lock/harness/baseline-plan/Context-IR identity checks, usage validation, and
catalog-cost finalization. Exact native Pi locked runtime additionally binds its
selected model/reasoning/routes/recovery/output allowance. The production-path
integration observes selected output `64` as provider
`max_output_tokens=64` with matching `x-cave-agent-build`; this is mechanism
proof, not causal savings. Standalone proxy
records content-blind Claude groundwork:
ordered prefix-component hashes, actual transform IDs, compression counts, and
CCR handles. Framework does not treat those fields as sufficient proof: strict
Claude locked execution rejects before SDK/MCP launch until all named gaps close.

## Public surface

- `agent`, `run`, `stream`, `createConversation`, `auto`
- `tool`, `schema`, `artifact`, `subagent`
- `context`, `file`, `memory`, `output`
- `createMemoryEngine`, `createMemoryWorkflow`, storage/embedding/sidecar adapters
- `eval`
- Context IR types and lowering helpers
- `verifySandboxConformance`
- `runClaudeAgent` from `@caveman-ai/adapter-claude-agent-sdk`
  (unlocked/inferred only)
- `createCodingAgent`, `startCodingSession`, `runCodingTurn`, `runCodingSession`,
  `defaultCodingPlan`, `proveRecovery` from `@caveman-ai/coding-agent`
- `createProgrammaticToolRuntime`, `programmaticToolInstructions`,
  `PROGRAMMATIC_TOOL_NAME`
- `createAdapter` plus capability manifest from each
  `@caveman-ai/adapter-*` package

CLI: `dev`, `build`, `check`, `doctor`, and `register`. `doctor` makes no model
request and prints `verified savings: $0` in human output.

Requires Node.js 22.19+. Framework package license: Apache-2.0. Claude Agent SDK use is
subject to Anthropic terms linked from that dependency's README.
