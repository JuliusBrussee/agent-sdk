# Migrate to Caveman

Mirror of the published page at `https://docs.caveman.so/docs/agent-sdk/migrate`.
Keep the two in step.

You already have an agent running on something else: Vercel AI SDK, Mastra,
LangGraph, OpenAI Agents, Strands, Cloudflare Agents, Eve, the Claude Agent
SDK, Flue, or a loop you wrote yourself. Nothing here asks you to rewrite it to
find out what it costs.

There are three depths. They are independent, and each one is useful alone.
Most agents should stop at the first or the second.

| Depth | What you change | What you get | What you keep |
|---|---|---|---|
| 1. The wire | One argument where you construct the provider client | Request ceiling, exact provider usage, provider-native cache hints | Everything. Your framework never learns about it |
| 2. The adapter | One object in a config array | A normalised usage record with its gaps visible, and one hook before the provider call | Your runner, retries, tools, streams, error types |
| 3. The port | The agent definition | Receipts, eval-gated builds, sandbox, durable runs, subagents | Your tools' bodies, your prompts, your evals as cases |

Depth 1 works on every framework in that list, including ones with no adapter
and ones nobody has heard of, because it attaches to `fetch` rather than to a
framework. Depth 2 needs a lane to exist for your framework. Depth 3 is a
rewrite of the definition, not of your tools.

## Depth 1: change one line

`@caveman-ai/agent/wire` puts a spend ceiling, exact usage accounting and
provider-native cache metadata on the request itself, before it leaves your
process. It attaches to the custom `fetch` every provider client already
accepts, so it scales by provider rather than by framework and needs no
adapter.

```ts
import { createAnthropic } from "@ai-sdk/anthropic";
import { createCavemanTransport } from "@caveman-ai/agent/wire";

const caveman = createCavemanTransport({
  budget: { maxTokens: 200_000 },
  onModelUsage: (usage) => usageLog.push(usage),
});

const anthropic = createAnthropic({ fetch: caveman.fetch });
```

That is the whole integration, and it is the same line whichever framework is
above it. Every `@ai-sdk/*` provider takes `fetch?: FetchFunction` at
construction, and so do the OpenAI, Anthropic and LangChain clients underneath
the other frameworks. A loop you wrote yourself can pass `caveman.fetch`
directly.

The full contract, including the exact hosts and paths it recognises, the
reserve and clamp rungs, and how usage settles when the provider reports
nothing, is at `https://docs.caveman.so/docs/agent-sdk/wire`. Three things
matter while you are migrating:

**It is deliberately incomplete.** Anthropic `/v1/messages` and OpenAI
`/v1/chat/completions` and `/v1/responses` are recognised. Every other request,
including Bedrock, passes through untouched, unmetered and unobserved rather
than being edited by a grammar nobody proved.

**Cache metadata is gated by default.** `cache` defaults to `"gated"`, which
releases only grammars proven against a live provider, and today that is the
OpenAI affinity routing key alone. The Anthropic splices are byte-parity tested
against the engine's fixtures but have never gone to a live endpoint from this
SDK, so they are held. If you want them, `cache: "all"` is the documented
opt-in, and `onCacheDecision` shows you every decision with `heldByScope` set
on the ones the gate stopped.

**It cannot compact or reroute.** Both rewrite what your framework believes it
sent, which would desync your framework's message state from the transcript the
model actually saw. Those live one layer up.

### Verify, and roll back

Verify: `onModelUsage` fires once per completed call with disjoint counts and
`null` for anything the provider did not report, and `meter.settled` moves by
the measured figure rather than the reserve.

Roll back: delete the `fetch` argument. Nothing else changed.

Because the transport is per client, you can run mixed: put it on one provider
client, leave the rest of your process on the default `fetch`, and compare.

## Depth 2: attach an adapter

Nine exact-pinned lanes exist. Six attach to a native seam your framework
already exposes, three run a Caveman agent definition on someone else's
runtime. Full detail, including which lanes can transform a request and which
only observe, is in [Adapters](https://docs.caveman.so/docs/agent-sdk/adapters).

The one thing worth repeating here: the adapter gives you the model boundary,
a list of middleware that runs immediately before your framework's provider
call, on the request your framework built, in your process. That is where
context compression, prompt trimming, redaction and model routing go, because
the boundary hands the rewritten request back to the framework instead of
sending it behind the framework's back.

Middleware receives no `next` and no provider function. An adapter cannot call
the model, cannot retry, and cannot become the thing that talks to the
provider.

Depth 1 and depth 2 compose. The transport can carry the budget and the cache
hints while the boundary carries compaction.

## Depth 3: port the agent

Do this when you want the receipt, the eval-gated build, the sandbox, or
durable runs. It is a rewrite of the definition. Your tool bodies, prompts and
eval cases move mostly intact.

### What maps

| What you have now | Where it goes | Notes |
|---|---|---|
| System prompt, in code or a file | `instructions`, or `instructions.md` | Raw markdown on both sides |
| Model id string | `model: "provider/model"`, or `auto()` | `auto()` reads `CAVE_MODEL`, then `.caveman/provider.json`, then the baseline for the sole credential. It never picks a model on quality |
| Tools with a Zod or JSON schema | `tool()` in `tools/` | Input accepts Standard Schema v1. Add `effect`: `read`, `write`, `idempotent`, `external`. The filename is the tool name |
| Retrieved documents, playbooks, policy text | `context()` | Declare `stability` and `safety`. Build-stable segments enter the frozen prefix; volatile data in a stable zone is rejected |
| Structured output schema | `output({ maxTokens, schema })` | Validation runs before the value can enter model context |
| Handoffs, sub-agents, graph nodes that call a model | `subagent()`, or `subagents/<name>/` | Each with its own `instructions.md` |
| Long-lived memory store | `@caveman-ai/agent/memory` | Local, opt-in, one turn behind, never in the frozen prefix |
| Max steps, turn caps, spend caps | `budget` and `breakers` | Enforced per run, root and descendants |
| Lifecycle callbacks and hooks | Your own code around `run()` or `stream()` | There is no hook surface to port to |
| Eval suite | `evals/*.eval.ts`, then `caveman-agent build` | A failed eval never produces a lock |
| Framework durable execution | `durable: { runId }` | A different model. Journal identity includes the build and plan digests, so one run id cannot replay under another build |
| Channels, schedules, cron, webhooks, connections | Nothing in v1 | Keep them where they are and call `run()` from them |

### What the port looks like per framework

**Vercel AI SDK, Mastra, Cloudflare Agents.** The closest shapes. Your model
id, your tool schemas and your tool bodies move almost literally; the thing you
delete is the loop. Add `effect` to each tool, which the frameworks do not ask
for and the sandbox and the compiler both need.

**OpenAI Agents.** Handoffs become `subagent()`. The agent-as-tool pattern
becomes a subagent too, not a `tool()`.

**LangGraph.** The largest port, because a graph is not an agent definition.
Port node by node: a node that calls a model becomes a run or a subagent, a
node that calls code stays your code, and the edges become ordinary control
flow around `run()`. If the graph is the product, stay at depth 1 or 2.

**Eve.** Mostly a file move, because the conventions overlap on purpose. That
one has its own page: [`eve-migration.md`](./eve-migration.md).

**Claude Agent SDK, Pi.** Do not port these. Write the Caveman definition and
run it on the runtime you already have through the runner lane. Pi is the only
lane that can lower a baseline plan into a cheaper one, and only for an agent
with no tools.

**Flue, and anything with no adapter.** Depth 1 works unchanged, depth 2 does
not exist for you, and depth 3 is the same port as everyone else's.

### The move

```bash
npm create @caveman-ai/agent@latest reference-bot   # a scaffold to copy from
caveman-agent doctor                                # names what is missing, spends nothing
caveman-agent dev                                   # first turn ends with the receipt
```

Keep scaffold next to real agent while moving `instructions.md`, `tools/*.ts`,
and skills into `.agents/skills/<name>/SKILL.md`. `doctor` makes zero provider calls, so
run it as often as you like.

## Verify each stage

| After | Check | What good looks like |
|---|---|---|
| Depth 1 | `onModelUsage`, `meter.settled` | One record per call, `null` where the provider said nothing, settlement on the measured figure |
| Depth 1 | `onCacheDecision` | `applied` on the grammar you expect, `heldByScope` where the gate held one |
| Depth 2 | Adapter usage sink and lifecycle events | Counts that are disjoint and cost that stays `unknown` when they are incomplete |
| Depth 3 | `caveman-agent doctor` | Node, sandbox containment, config, Context IR, provider selection all pass |
| Depth 3 | The end-of-run receipt | A list-price subtotal, warm reads provider-reported, the cold counterfactual labeled `inferred` |
| Depth 3 | `caveman-agent build` | A lock, or a named eval failure and no lock |

## Roll back

Depth 1: remove the `fetch` argument. Depth 2: remove the adapter object from
the config array; your framework keeps its native result and its native error.
Depth 3: the old agent is untouched code in another directory until you delete
it, so run both against the same cases before you do.

None of the three is one-way, and none of them requires the others.

## What none of this claims

Local results are `inferred`: a per-run estimate from your own traffic.
`measured` means observed traffic. `verified` is reserved for a system that can
compare against a bill, and nothing on this page emits it. No figure here is
multiplied into a monthly number, and verified savings stay $0.

Without the Caveman runtime installed, a native run reports
`mode: "observe-only"`: your provider's own base URL, no transform, no gateway
telemetry. Provider usage and local context estimates still work. The wire
transport is independent of that and works either way.
