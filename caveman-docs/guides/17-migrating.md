# Migrating to Caveman

You already have an agent on something else — Vercel AI SDK, Mastra, LangGraph,
OpenAI Agents, Strands, Cloudflare Agents, Eve, the Claude Agent SDK, Flue, or a
loop you wrote. Nothing here asks you to rewrite it to find out what it costs.

There are three depths. They are independent, each is useful alone, and none is
one-way. Most agents should stop at the first or the second.

| Depth | What you change | What you get | What you keep |
| --- | --- | --- | --- |
| **1. The wire** | One argument where you construct the provider client | Request ceiling, exact provider usage, provider-native cache hints | Everything. Your framework never learns about it |
| **2. The adapter** | One object in a config array | A normalized usage record with its gaps visible, and one hook before the provider call | Your runner, retries, tools, streams, error types |
| **3. The port** | The agent definition | Receipts, eval-gated builds, sandbox, durable runs, subagents | Your tool bodies, your prompts, your evals as cases |

Depth 1 works on every framework in that list — including ones with no adapter —
because it attaches to `fetch`. Depth 2 needs a lane to exist. Depth 3 is a
rewrite of the definition, not of your tools.

---

## Depth 1: change one line

```ts
import { createAnthropic } from "@ai-sdk/anthropic";
import { createCavemanTransport } from "@caveman-ai/agent/wire";

const caveman = createCavemanTransport({
  budget: { maxTokens: 200_000 },
  onModelUsage: (usage) => usageLog.push(usage),
});

const anthropic = createAnthropic({ fetch: caveman.fetch });
```

That is the whole integration, and it is the same line whichever framework sits
above it. Every `@ai-sdk/*` provider takes `fetch?: FetchFunction` at
construction, and so do the OpenAI, Anthropic, and LangChain clients underneath
the other frameworks. A loop you wrote yourself passes `caveman.fetch` directly.

Three things matter while migrating:

- **It is deliberately incomplete.** Anthropic `/v1/messages` and OpenAI
  `/v1/chat/completions` + `/v1/responses` are recognized. Everything else,
  including Bedrock, passes through untouched, unmetered, and unobserved rather
  than being edited by an unproven grammar.
- **Cache metadata is gated by default.** `cache: "gated"` releases only
  live-proven grammars — today the OpenAI affinity routing key alone.
  `cache: "all"` is the documented opt-in; `onCacheDecision` shows every
  decision, with `heldByScope` on the ones the gate stopped.
- **It cannot compact or reroute.** Both rewrite what your framework believes it
  sent. They live one layer up.

**Verify:** `onModelUsage` fires once per completed call with disjoint counts and
`null` for anything the provider did not report, and `meter.settled` moves by the
measured figure rather than the reserve.

**Roll back:** delete the `fetch` argument. Nothing else changed. Because the
transport is per client, you can run mixed — one provider client metered, the
rest on default `fetch` — and compare.

Full contract: [Adapters and the wire transport](16-adapters-and-wire.md).

---

## Depth 2: attach an adapter

Nine exact-pinned lanes exist. The thing worth repeating: the adapter gives you
the **model boundary**, middleware that runs immediately before your framework's
provider call, on the request your framework built, in your process. That is
where context compression, prompt trimming, redaction, and model routing go,
because the boundary hands the rewritten request back to the framework instead
of sending it behind the framework's back.

Middleware receives no `next` and no provider function. An adapter cannot call
the model, cannot retry, and cannot become the thing that talks to the provider.

Depths 1 and 2 compose.

**Verify:** the adapter's usage sink and lifecycle events produce disjoint counts
and cost that stays `unknown` when they are incomplete.

**Roll back:** remove the adapter object from the config array; your framework
keeps its native result and its native error.

---

## Depth 3: port the agent

Do this when you want the receipt, the eval-gated build, the sandbox, or durable
runs.

### What maps

| What you have now | Where it goes | Notes |
| --- | --- | --- |
| System prompt, in code or a file | `instructions`, or `instructions.md` | Raw markdown on both sides |
| Model id string | `model: "provider/model"`, or `auto()` | `auto()` reads `CAVE_MODEL`, then `.caveman/provider.json`, then the baseline for the sole credential. It never picks a model on quality |
| Tools with a Zod or JSON schema | `tool()` in `tools/` | Input accepts Standard Schema v1. Add `effect`. The filename is the tool name |
| Retrieved documents, playbooks, policy text | `context()` | Declare `stability` and `safety`. Build-stable segments enter the frozen prefix; volatile data in a stable zone is rejected |
| Structured output schema | `output({ maxTokens, schema })` | Validation runs before the value can enter model context |
| Handoffs, sub-agents, graph nodes that call a model | `subagent()`, or `subagents/<name>/` | Each with its own `instructions.md` |
| Long-lived memory store | `@caveman-ai/agent/memory` | Local, opt-in, one turn behind, never in the frozen prefix |
| Max steps, turn caps, spend caps | `budget` and `breakers` | Enforced per run, root and descendants |
| Lifecycle callbacks and hooks | Your own code around `run()` / `stream()` | There is no hook surface to port to |
| Eval suite | `evals/*.eval.ts`, then `caveman-agent build` | A failed eval never produces a lock |
| Framework durable execution | `durable: { runId }` | A different model. Journal identity includes the build and plan digests |
| Channels, schedules, cron, webhooks, connections | Nothing in v1 | Keep them where they are and call `run()` from them |

### Per framework

| Framework | Shape of the port |
| --- | --- |
| **Vercel AI SDK, Mastra, Cloudflare Agents** | The closest shapes. Model id, tool schemas, and tool bodies move almost literally; what you delete is the loop. Add `effect` to each tool — the sandbox and the compiler both need it |
| **OpenAI Agents** | Handoffs become `subagent()`. The agent-as-tool pattern becomes a subagent too, not a `tool()` |
| **LangGraph** | The largest port, because a graph is not an agent definition. Port node by node: a model-calling node becomes a run or a subagent, a code node stays your code, edges become ordinary control flow around `run()`. If the graph *is* the product, stay at depth 1 or 2 |
| **Eve** | Mostly a file move; the conventions overlap on purpose. See below |
| **Claude Agent SDK, Pi** | Do not port these. Write the Caveman definition and run it on the runtime you already have through the runner lane. Pi is the only lane that can lower a baseline plan into a cheaper one, and only for a tool-free agent |
| **Flue, and anything with no adapter** | Depth 1 works unchanged; depth 2 does not exist for you; depth 3 is the same port as everyone else's |

### The move

```bash
npm create @caveman-ai/agent@latest reference-bot   # a scaffold to copy from
caveman-agent doctor                                # names what is missing, spends nothing
caveman-agent dev                                   # first turn ends with the receipt
```

Keep scaffold next to real agent while moving `instructions.md`, `tools/*.ts`,
and skills across. `doctor` makes zero provider calls.

**Verify:** `caveman-agent doctor` passes Node, sandbox containment, config,
Context IR, and provider selection; the end-of-run receipt shows a list-price
subtotal with warm reads provider-reported and the cold counterfactual labeled
`inferred`; `caveman-agent build` produces a lock, or a named eval failure and no
lock.

**Roll back:** the old agent is untouched code in another directory until you
delete it, so run both against the same cases first.

---

## Migrating from Eve specifically

Eve's layout and the agent-directory convention overlap on purpose. There is no
import command and nothing rewrites your files. `caveman-agent doctor`, run
inside an eve directory, recognizes the layout and prints the short version of
this table.

| In your eve directory | Here | The move |
| --- | --- | --- |
| `agent/instructions.md` | `instructions.md` | Move as-is |
| `agent/tools/*.ts` | `tools/*.ts` | Move; filename = tool name on both sides. Rewrite each export to this package's `tool()` |
| `agent/skills/*.md` | `.agents/skills/<name>/SKILL.md` | Move each file into matching directory; keep Agent Skills `name` and `description` frontmatter |
| `agent/skills/*.ts` | — | No TypeScript skills here; a procedural skill becomes a tool |
| `agent/subagents/<name>/` | `subagents/<name>/` | Move; same nested-directory idea |
| `agent/agent.ts` | `agent.ts` | **Rewrite**, not move — here it exports an `AgentDirConfig` |
| `agent/sandbox/` | `sandbox/sandbox.ts` | Rewrite against the three sandbox modes; eve's sandbox rides Vercel Sandbox |
| `agent/channels/` | none | **No v1 equivalent.** Your own code calls `run()` |
| `agent/schedules/` | none | **No v1 equivalent.** Use your own cron |
| `agent/connections/` | none | **Not supported.** Tools read provider keys from an explicit env allow-list |
| `agent/hooks/` | none | Lifecycle behavior belongs in your calling code |

Flatten: everything lives at the project root, no `agent/` nesting, next to
`caveman.config.ts`.

If your agent's value lives in its Slack channel or its cron schedule, keep it on
eve and wire Caveman in where a run's cost matters.

Local copies of these pages:
[`migrate.md`](../../packages/agent/docs/migrate.md),
[`eve-migration.md`](../../packages/agent/docs/eve-migration.md).

---

## What none of this claims

Local results are `inferred`: a per-run estimate from your own traffic.
`measured` means observed traffic. `verified` is reserved for a system that can
compare against a bill, and nothing here emits it. No figure is multiplied into a
monthly number, and verified savings stay `$0`.

Without the Caveman runtime installed a native run reports
`mode: "observe-only"`. The wire transport is independent of that and works
either way.
