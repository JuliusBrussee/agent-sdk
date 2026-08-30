# Budgets, receipts, and breakers

Three separate mechanisms, often confused:

| Mechanism | Question it answers | Failure shape |
| --- | --- | --- |
| `RunOptions.budget` | How much may this run spend, and what happens at the ceiling? | A planned end state: a normal result with a `stopReason` |
| `RunOptions.maxCostUsd` | Best-effort local cap on one run's USD | Terminates the run with `cave_run_cost_budget_exceeded` |
| `RunOptions.breakers` | Is this run looping, stalling, or fanning out? | A deterministic break, recorded on the receipt |

`budget` and `maxCostUsd` are **mutually exclusive**.

## `RunBudget`

```ts
const budget: RunBudget = {
  maxTokens: 120_000,        // XOR maxUsd
  onExhausted: "compact",
  outputFloorTokens: 256,
  compaction: { keepRecentTokens: 8_000, summaryMaxTokens: 2_048 },
};
```

| Field | Type | Notes |
| --- | --- | --- |
| `maxUsd` | `number` | Hard cap at public catalog list prices. Mutually exclusive with `maxTokens` |
| `maxTokens` | `number` | Hard cap in provider-counted tokens |
| `initialUsd` / `initialTokens` | `number` | Staged release: the run starts metered against this, not `max` |
| `outputFloorTokens` | `number` | Clamp floor. Defaults to `OUTPUT_CLAMP_FLOOR_TOKENS` (256) |
| `onExhausted` | `"compact" \| "stop"` | `compact` (default) rewrites context while the same cap can still fund the rewrite plus useful work; `stop` clamps and stops only when the next call no longer fits |
| `compaction` | `CompactionOptions` | Ignored when `onExhausted` is `"stop"` |

### Exactly one denomination

A denomination the runtime cannot honestly meter fails closed **before the first
provider call**. `maxUsd` needs a catalog-priced model, because a cap that
cannot be measured is not a cap (`cave_budget_denomination_unavailable`).

### Reserve and clamp

There is one enforcement mode and no soft option:

1. Before every provider call, hold that call's worst-case price against the
   budget.
2. When the remainder cannot cover the configured output allowance, **clamp**
   the call's output down to what the remainder affords.
3. Below `outputFloorTokens`, **stop**.

Stopping is a normal result carrying a `stopReason`, never a throw. An in-flight
call always finishes and is counted, and the runtime never stops mid-tool.

**The guarantee, exactly:** the runtime never *chooses* to spend past `max`.
When a provider nonetheless reports more than could be bounded, the run settles
at the **true** amount — a ledger that clamps what a call cost is a fake ledger
— sets `capBreached` with a signed `overspent`, and stops. A breach is loud and
terminal, and rolls up from any subagent wallet that breached beneath the run.

### Credential regime

A USD budget on Pi's own transport, off the gateway, is refused when the local
credential store cannot prove the credential is a metered API key. Set
`RunOptions.assumeMeteredCredential: true` to assert on your own authority that
the credential is billed per token. Ignored for a caller-supplied `streamFn` and
for a routed gateway whose identified readiness response proves
`billing: "managed"`.

### Staged release

```ts
import { createBudgetController } from "@caveman-ai/agent";

const budgetController = createBudgetController();
await run(definition, input, {
  budget: { maxUsd: 5, initialUsd: 1 },
  budgetController,
  onBudgetExhausted: (context) => {
    if (context.calls < 20) budgetController.release(1, "checkpoint reached");
  },
});
```

The exhaustion handler sees only meter figures — `denomination`, `max`,
`released`, `spent`, `remaining`, `releasable`, `calls` — runs between calls with
nothing in flight, and never receives prompt, output, tool, or model content.
Continuation never crosses `max`: a handler asking for more than the contract
allows throws at the release. Nothing the model produces can reach the
controller.

## Stop reasons

```ts
type RunStopReason =
  | "complete"                // ordinary end of the loop
  | "budget_exhausted"
  | "deadline"                // RunOptions.deadlineMs
  | "loop_detected"
  | "no_progress"
  | "wallet_revoked"
  | "call_budget_exhausted";  // RunOptions.maxModelCalls
```

Every value except `complete` means the runtime stopped the run **between**
calls.

## Other ceilings

| Option | Default | Effect |
| --- | --- | --- |
| `maxModelCalls` | 64 | Graceful stop with `call_budget_exhausted`; never a throw that would destroy the ledger |
| `maxToolCalls` | 64 | Extra tool calls are blocked; the model sees a blocked result |
| `deadlineMs` | unset | Wall clock, enforced at the same between-calls points; `stopReason: "deadline"` |
| `maxSubagentDepth`, `maxSubagentInvocations`, `maxConcurrentSubagents` | see [Agent definitions](02-agent-definitions.md) | Root-tree subagent ceilings |

An efficiency-plan run derives a tighter default `maxModelCalls` from its
retry-cascade reserve; an explicit caller value always overrides.

## The receipt

Every successful run returns a `RunReceipt`. A run that fails after spending
throws `CavemanRunError` carrying the **same partial receipt** — the per-call
breakdown is never lost.

```ts
const { receipt } = await run(definition, input, { budget });
```

| Field | Meaning |
| --- | --- |
| `schema` | `AGENT_RUN_RECEIPT_SCHEMA` |
| `runId`, `agentId` | Identity |
| `basis` | Always `"estimated_list_price_subtotal"` |
| `claimBasis` | Always `"inferred"` |
| `stopReason` | See above |
| `denomination` | `"usd"`, `"tokens"`, or `"none"` when no budget was declared |
| `max`, `released`, `spent` | Meter figures in the run's own denomination |
| `capBreached`, `overspent` | Loud terminal breach; `overspent` is this run's own meter, not a tree total |
| `totalEstimatedUsd`, `totalTokens` | This run and everything under it |
| `unpriced` | True when any call here or in a subagent went unpriced |
| `calls` | `ReceiptCall[]` — provider, model, all token classes, `estimatedUsd`, `usageBasis`, `clampedOutputTokens` |
| `tools` | `ReceiptTool[]` — name, calls, errors |
| `subagents` | Nested receipts, each with its own figures |
| `tranches` | Every staged release: amount, reason, call index |
| `breakers` | Every deterministic breaker decision, so a break is never silent |
| `compactions` | Every compaction, with real cost and modeled effect kept apart |
| `resume` | Present only on a resumed durable run |

### Compaction entries

`ReceiptCompaction` deliberately separates `meteredCost`/`meteredBasis:
"measured"` from `modeledNetTokens`/`modeledBasis: "modeled"`. `cacheState`
records what the provider reported on the last working call; the affordability
model still prices the summarizer **cold**, because the rewrite diverges from
the working call's prefix at its first changed message.

### Resume entries

`ReceiptResume.possibleDoubleCountCalls` is the at-least-once ceiling made
visible: calls whose intent was journaled but whose usage never came back. They
appear in **no other figure** on the receipt. See [Durable runs](10-durable-runs.md).

### Printing

```ts
import { renderReceipt, writeRunReceipt } from "@caveman-ai/agent";
```

`run()` prints the receipt automatically for directory-loaded agents
(`printReceipt` defaults on there, off everywhere else, because stdout may be a
protocol channel a receipt would corrupt).

## Breakers

Every breaker decision is a hash comparison or an integer count. **No model runs
anywhere in the breaker path** — a model judge cannot participate in stopping or
accounting.

```ts
const breakers: RunBreakers = {
  repeatedToolCalls: 3,
  repeatedToolCallWindowTurns: 8,
  noProgressTurns: 3,
  maxToolCallsPerTurn: 8,
  retry: { maxSpend: 0.05, backoffMs: 250 },
};
```

| Field | Default | Behavior |
| --- | --- | --- |
| `repeatedToolCalls` | 3 | Identical tool + normalized arguments. Counted per hash, reset by an intervening failure |
| `repeatedToolCallWindowTurns` | 8 | Assistant-turn window; older calls decay out, so old successful work cannot poison a long run |
| `noProgressTurns` | 3 | Consecutive read-only turns with an identical outcome signature. A successful declared write resets the window, because equal display text is not proof host state stayed equal |
| `maxToolCallsPerTurn` | 8 | Fan-out ceiling per assistant turn; extras are blocked |
| `retry` | none | Cost-aware retry for model calls that fail **before producing any usage** |

Set `allowRepeat: true` on a tool whose job is to be called again with the same
arguments — polling a queue, waiting on a build, re-reading a changing file.

### Retry accounting

Every retry takes a real hold from the run's meter. A pre-stream failure cancels
the hold and records measured zero; a successful retry settles provider usage.
Worst-case reserved exposure stays capped, so a zero-spend error storm cannot
retry forever. Backoff is deterministic — no jitter, because a breaker must be
reproducible. A retry policy **requires a budget**: without one there is no
denomination to reserve.

### Breaker events

```ts
type BreakerEvent = {
  kind: "loop_detected" | "no_progress" | "fan_out_blocked" | "retry_attempted" | "retry_exhausted";
  tool?: string;
  count: number;
  signature?: string;
  reservedSpend?: number;
  measuredSpend?: number;
  spendBasis?: "pre_stream_no_usage" | "provider_reported" | "unavailable_worst_case";
};
```

Coding turns enable the repeated-call, no-progress, and fan-out breakers by
default (`CODING_RUN_BREAKERS`).
