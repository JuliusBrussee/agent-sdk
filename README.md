<p align="center">
  <img src="docs/assets/caveman-logo-banner.png" alt="Caveman" width="720">
</p>

<p align="center">
  <strong>other framework build agent. this one build agent with receipt.</strong>
</p>

<p align="center">
  Every agent framework gives your agent tools, memory, and subagents. So does this one.<br>
  Then it does the thing none of them do: <strong>it hands you the bill.</strong><br>
  Every run. Every call. Every crash. Priced, capped, journaled, and proven on a holdout.
</p>

<p align="center">
  <a href="#license"><img src="https://img.shields.io/badge/license-MIT-green?style=flat" alt="MIT"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A522.19-blue?style=flat" alt="Node 22.19+">
  <img src="https://img.shields.io/badge/tests-530_passing-brightgreen?style=flat" alt="530 tests">
  <img src="https://img.shields.io/badge/receipts-byte--law_goldens-yellow?style=flat" alt="golden receipts">
  <img src="https://img.shields.io/badge/local_savings-always_inferred-orange?style=flat" alt="savings stay inferred">
</p>

<p align="center">
  <a href="#the-receipt">The receipt</a> ·
  <a href="#budgets-that-refuse-to-lie">Budgets</a> ·
  <a href="#crash-it-the-meter-survives">Durable runs</a> ·
  <a href="#the-compiler">The compiler</a> ·
  <a href="#everything-else-you-expect">Features</a> ·
  <a href="#start">Start</a> ·
  <a href="#the-honesty-boundary">Honesty</a>
</p>

---

## Ten lines. Whole agent.

```ts
import { agent, auto } from "@caveman-ai/agent";

export default agent({
  id: "support",
  instructions: "Answer from policy. Never invent policy.",
  model: auto(),
});
```

```ts
import support from "./agent.js";
import { run } from "@caveman-ai/agent";

const result = await run(support, "Can I get a refund?");
console.log(result.text);
console.log(result.contextBill);
```

Nothing but Node and a provider key. No account, no gateway, no telemetry
phone-home. It runs direct to your provider and ends with the thing every other
framework forgot to build.

## The receipt

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

Read that again. Which models ran, how many calls each, warm-read tokens as the
**provider** reported them, cost at public catalog list prices, what the same
run would have cost cold, and how much budget is left. Root agent, subagents,
retries — every model call lands in one ledger. A run that fails after spending
still throws with the partial receipt attached, because losing the breakdown at
the exact moment money burned is how every other framework does it.

And here's the part that should make you trust the rest of this page: **that
receipt is a golden file.** The test suite renders the real receipt and fails
if the output drifts by a byte. The marketing copy is under test.

## Budgets that refuse to lie

`maxCostUsd: 0.05` means the run cannot spend more than five cents. Not "we'll
check afterwards" — every call reserves its catalog worst-case price *before*
the request and settles the measured cost after. Cap exhausted? The run ends
before the next call, receipt intact.

The smart part is what happens when a cap is impossible to enforce:

```text
✗ build failed: your budget is in dollars but the model has no price

  agent.ts:4     model: "acme-lab-preview"
  agent.ts:9     budget: { maxUsd: 0.05 }

  acme-lab-preview is not in the public price catalog, so a dollar
  budget cannot be enforced against it. Guessing a price would make the
  cap fiction, so the build fails instead.

  An unpriced model never spends against an imaginary $0 rate.
```

Most frameworks would price the unknown model at zero and call the budget
"enforced." This one refuses the run. Fail-closed is a feature you don't
appreciate until the day it saves you, and then you never use anything else.

## Crash it. The meter survives.

Turn on durable mode and every model call journals its **intent** to disk,
fsynced, *before* the request goes out. Kill the process mid-run — power cord,
OOM, ctrl-C, doesn't matter. Resume with the same `runId` and the run picks up
at the last clean boundary with the meter preloaded: money already spent is
never re-reserved and never forgotten.

```text
run complete · 2 turns · 5.1s

  cost           $0.0107   list-price subtotal, not an invoice
  budget         $0.0107 spent of $0.05 · 78% remains
  resumed        attempt 2 · prior attempts: 2 calls, $0.0059 — included in the totals above
                 1 call was in flight at a crash — the provider
                 may have billed it; that usage is unknown and counted nowhere
```

Look at those last two lines. A call was mid-flight when the process died, so
its cost is genuinely unknowable — and the receipt **says so**, instead of
quietly guessing. This is what accounting looks like when it's built by people
who expect to be audited. No Temporal cluster, no Postgres, no workflow server:
one JSONL journal next to your agent.

## The compiler

This is the headline act. Your agent is not just code that runs — it's code
that **builds**, and the build makes it cheaper:

```bash
npm run build
```

One command: profile the workload with your approved evals, search cheaper
plans on a development set — model selection, reasoning effort, reversible
context routes with derived recovery, output budgets — freeze the winner, then
prove it on a **holdout set the search never touched**. Train/test split for
your agent's cost. If traces already exist under `.caveman/traces/`, the build
imports them and skips the profiling spend entirely.

A plan that can't prove itself doesn't lock:

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

The output is an immutable Cave Build: a lockfile, a content-blind workload
profile, and a build report with the holdout evidence and search cost. Cheaper,
with proof attached — or no lock at all.

## Everything else you expect

Because a framework that only did accounting would be a spreadsheet.

| | |
|---|---|
| **Tools & subagents** | Typed tools, subagent trees, every descendant call metered into the root receipt. |
| **Sandboxed execution** | Restricted-tool policy with a written [threat model](./packages/agent/SANDBOX_THREAT_MODEL.md), not a vibe. |
| **Directory conventions** | `loadAgentDir`: a folder of markdown + tools *is* an agent. Skills ship descriptions in the frozen prefix; bodies load on demand. |
| **Cache planning** | Provider cache breakpoints planned statically, parity-checked against Go fixtures. Hints only — model-visible bytes never change. |
| **Streaming** | Typed run/context/completion/error events; aborting the iterator aborts in-flight provider, tool, and subagent work. |
| **Adapters** | Exact-pinned: Pi, Claude Agent SDK, Vercel AI SDK, Eve, Mastra. Migrate in, keep your receipts. |
| **Zero-dep initializer** | `create-agent` scaffolds a production-shaped support bot with evals that gate the build — the two-minute proof. |

## Start

```bash
npm create @caveman-ai/agent@latest my-agent
cd my-agent
npm run doctor    # checks your key, tells you the one-line fix if it's missing
npm run dev
```

Or straight into an existing project:

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

The reason to believe any number above: this SDK is built under rules that make
fake numbers a correctness bug.

- Costs are **list-price subtotals** at the public catalog, never invoices.
- Local execution and replay evidence stay **`inferred`** — the SDK does not
  publish a savings percentage, and `verifiedSavingsUsd` stays `0` until real
  traffic passes Caveman Cloud rollout and ledger gates.
- Unknown price, model, or runtime state **fails closed** or returns an honest
  zero. Nothing is ever guessed.

Most frameworks would call this section a limitation. It's the product.

## License

MIT. The Anthropic Claude Agent SDK dependency remains governed by Anthropic
terms; see the framework README and sandbox threat model for the exact boundary.
