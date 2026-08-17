<p align="center">
  <img src="docs/assets/caveman-logo-banner.png" alt="Caveman" width="720">
</p>

<p align="center">
  <strong>other framework build agent. this one build agent with receipt.</strong>
</p>

<p align="center">
  A TypeScript agent framework where the agent is a folder of markdown,<br>
  every run ends with a priced receipt, budgets are enforced before the call,<br>
  and <code>npm run build</code> compiles the agent cheaper — proven on a holdout.
</p>

<p align="center">
  <a href="#license"><img src="https://img.shields.io/badge/license-MIT-green?style=flat" alt="MIT"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A522.19-blue?style=flat" alt="Node 22.19+">
  <img src="https://img.shields.io/badge/tests-530_passing-brightgreen?style=flat" alt="530 tests">
  <img src="https://img.shields.io/badge/receipts-byte--law_goldens-yellow?style=flat" alt="golden receipts">
  <img src="https://img.shields.io/badge/local_savings-always_inferred-orange?style=flat" alt="savings stay inferred">
</p>

<p align="center">
  <a href="#the-folder-is-the-agent">The folder</a> ·
  <a href="#every-run-ends-with-a-receipt">The receipt</a> ·
  <a href="#budgets">Budgets</a> ·
  <a href="#crash-and-resume">Durable runs</a> ·
  <a href="#the-build">The build</a> ·
  <a href="#start">Start</a> ·
  <a href="#the-honesty-boundary">Honesty</a>
</p>

---

## The folder is the agent

```text
support-bot/
├── instructions.md          # who the agent is — plain markdown
├── agent.ts                 # model, budget, config — behavior only
├── skills/
│   ├── refund-policy.md     # frontmatter description + body
│   └── shipping-claims.md
├── tools/
│   └── lookup_order.ts      # default export is a tool()
├── subagents/               # each subdir is another agent dir
└── evals/
    └── support.eval.ts      # gates the build (below)
```

```ts
import { loadAgentDir } from "@caveman-ai/agent";

const support = await loadAgentDir("./support-bot");
```

Prose lives in markdown, behavior lives in one small TypeScript file, and
`loadAgentDir` lowers the whole directory into an ordinary agent definition.
Skills work the way context should: each `skills/*.md` puts its one-line
description into the frozen, cacheable prompt prefix, and the body stays on
disk until the model asks for it through the `cave_skill` tool. Loading a body
never moves the prefix. Editing `refund-policy.md` is the whole deployment.

`npm create @caveman-ai/agent@latest` scaffolds exactly this folder — a
production-shaped support bot with real policy skills, a sandboxed order-lookup
tool, and evals wired in.

Prefer plain code? Same thing, no directory:

```ts
import { agent, auto, run } from "@caveman-ai/agent";

const support = agent({
  id: "support",
  instructions: "Answer from policy. Never invent policy.",
  model: auto(),
});

const result = await run(support, "Can I get a refund?");
console.log(result.text);
console.log(result.contextBill);
```

Either way it runs on nothing but Node and a provider key. Direct to your
provider, no account, no phone-home.

## Every run ends with a receipt

```text
run complete · 4 turns · 8.2s

  model          claude-sonnet-5 (3 calls) · claude-haiku-4-5 (1 call)
  mode           observe-only — engine adds compression + recovery
  input          14,102 tok · 12,800 read warm (provider-reported)
  output         412 tok
  cost           $0.0085   list-price subtotal, not an invoice
  cold estimate  $0.0316   inferred — same run with no warm prefix
  budget         $0.0085 spent of $0.05 · 83% remains

  full receipt   .caveman/runs/2026-08-14T15-02-11/receipt.json
```

Which models ran, how many calls each, warm-read tokens as the provider
reported them, cost at public catalog list prices, budget remaining. Subagent
and retry calls land in the same ledger as the root. A run that fails after
spending throws with the partial receipt attached.

That block is a golden file. `npm test` renders the real receipt and fails if
the output drifts by a byte, so the quotes in this README stay true or the
build goes red.

## Budgets

`maxCostUsd: 0.05` reserves each call's catalog worst-case price before the
request and settles the measured cost after it. When the cap runs out, the run
ends before the next call, receipt intact.

A model the catalog can't price can't be capped, and the framework refuses to
pretend otherwise:

```text
✗ build failed: your budget is in dollars but the model has no price

  agent.ts:4     model: "acme-lab-preview"
  agent.ts:9     budget: { maxUsd: 0.05 }

  acme-lab-preview is not in the public price catalog, so a dollar
  budget cannot be enforced against it. Guessing a price would make the
  cap fiction, so the build fails instead.

  An unpriced model never spends against an imaginary $0 rate.
```

## Crash and resume

With durable mode on, every model call fsyncs its intent to a JSONL journal
before the request leaves the machine. Kill the process wherever you like;
resume with the same `runId` and the run continues from the last clean boundary
with the meter preloaded — spent money is never re-reserved and never dropped.

```text
run complete · 2 turns · 5.1s

  cost           $0.0107   list-price subtotal, not an invoice
  budget         $0.0107 spent of $0.05 · 78% remains
  resumed        attempt 2 · prior attempts: 2 calls, $0.0059 — included in the totals above
                 1 call was in flight at a crash — the provider
                 may have billed it; that usage is unknown and counted nowhere
```

A call that was mid-flight at the crash has a genuinely unknowable cost, so the
receipt labels it unknown instead of guessing. No workflow server, no Postgres;
the journal is a file next to your agent.

## The build

```bash
npm run build
```

Profiles the workload with your approved evals, searches cheaper plans on a
development set — model selection, reasoning effort, reversible context routes
with derived recovery, output budgets — freezes the winner, then proves it on a
holdout set the search never touched. Existing traces under `.caveman/traces/`
are imported instead of re-spending on profiling.

A plan that fails its evals never locks:

```text
✗ build failed: both development evals fail on the cheapest candidate plan

    ✗ order-status         (development)  expected the order id in the reply, none found
    ✗ angry-escalation     (development)  reply must name the human escalation path

  The build only locks a plan that passes every development eval you
  declared. The cheapest candidate failed both, and the next candidate
  up also failed, so no plan locked.

  Weakening a grader to make a build pass is a product decision;
  make it on purpose.
```

A successful build writes an immutable Cave Build: lockfile, content-blind
workload profile, and a build report carrying the holdout evidence and what the
search itself cost.

## Also in the box

| | |
|---|---|
| **Tools & subagents** | Typed tools, subagent trees, every descendant call metered into the root receipt. |
| **Sandboxed execution** | Restricted-tool policy with a written [threat model](./packages/agent/SANDBOX_THREAT_MODEL.md). |
| **Cache planning** | Provider cache breakpoints planned statically, parity-checked against Go fixtures. Hints only; model-visible bytes never change. |
| **Streaming** | Typed run/context/completion/error events; aborting the iterator aborts in-flight provider, tool, and subagent work. |
| **Adapters** | Exact-pinned: Pi, Claude Agent SDK, Vercel AI SDK, Eve, Mastra. |
| **Zero-dep initializer** | `create-agent` scaffolds the support bot above, evals included. |

## Start

```bash
npm create @caveman-ai/agent@latest my-agent
cd my-agent
npm run doctor    # checks your key, tells you the one-line fix if it's missing
npm run dev
```

Or into an existing project:

```bash
npm install @caveman-ai/agent
```

Full API and safety contract: [packages/agent/README.md](./packages/agent/README.md).

## Develop

Requires Node.js 22.19+.

```bash
npm ci --prefix packages/agent
npm ci --prefix packages/create-caveman-agent
npm ci --prefix examples/coding-agent --ignore-scripts
npm test
npm run pack:check
```

`npm test` checks the generated provider catalog, 507 runtime tests, 10
compiler-replay tests, the deterministic replay artifact, the initializer
suite, and the example agent. macOS restricted-tool tests require working
`sandbox-exec` and loopback access.

## Packages

- `packages/agent` — `@caveman-ai/agent` v0.2 compiler/runtime.
- `packages/create-caveman-agent` — zero-runtime-dependency project initializer.
- `packages/shared` — pinned wire schemas and provider-catalog snapshot required
  to regenerate and verify Agent SDK artifacts.
- `internal/agentbench/corpus` — pinned Apache-2.0 evaluation subset used only by
  deterministic compiler replay.

## The honesty boundary

Costs are list-price subtotals at the public catalog, never invoices. Local
execution and replay evidence stay `inferred`; the SDK publishes no savings
percentage, and `verifiedSavingsUsd` stays `0` until real traffic passes
Caveman Cloud rollout and ledger gates. Unknown price, model, or runtime state
fails closed or returns an honest zero.

## License

MIT. The Anthropic Claude Agent SDK dependency remains governed by Anthropic
terms; see the framework README and sandbox threat model for the exact boundary.
