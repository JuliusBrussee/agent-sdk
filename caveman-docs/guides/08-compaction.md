# Compaction

Compaction only happens inside a declared token or USD budget. It is one rung of
a fail-closed ladder, not an ambient background process.

## The ladder

```text
1. exact-recovery eviction   evict segments whose original bytes can be restored
2. typed summary             one paid summary producing cave.context-summary.v2
3. output clamp              shrink the outgoing max_tokens to what remains
4. stop                      normal result with a stopReason, never a throw
```

Provider calls and measured usage from the summary land on the run's ordinary
receipt.

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

const result = await run(support, "Continue the investigation.", { budget });
```

## `cave.context-summary.v2`

The capsule carries source IDs, SHA-256 digests, a generation counter, and typed
anchors. The runtime accepts a replacement **only** when:

- the schema parses;
- the generation increments by exactly one;
- required user sources are covered;
- source IDs and SHA-256 digests match;
- tool content did not mint critical policy;
- every prior critical anchor survives **byte-identically**, unless a later
  current user source grounds a new critical anchor with an explicit
  `supersedes` edge;
- root user intent and the self-contained recent tail remain verbatim;
- the rewritten context is smaller.

A failed transition is rejected — the prior context stands.

One paid summary remains the default. Structural support for repeated compaction
is tested, but raising the default needs repeated live-model semantic evidence.

## Public API

```ts
import {
  contextSummarySources,
  latestContextSummary,
  normalizeCompaction,
  parseContextSummary,
  renderSummary,
  runContextCompactionHarness,
  summarizationInstruction,
  validateContextSummaryTransition,
  SUMMARY_SCHEMA_VERSION,
} from "@caveman-ai/agent/compaction";
```

| Export | Purpose |
| --- | --- |
| `parseContextSummary` | Parse and validate a capsule |
| `validateContextSummaryTransition` | Enforce every rule above between two generations |
| `contextSummarySources` / `latestContextSummary` | Inspect what a capsule covers |
| `summarizationInstruction` | The exact instruction handed to the summarizing model |
| `renderSummary` | Render a capsule back into context bytes |
| `normalizeCompaction` | Normalize `CompactionOptions` into the runtime shape |
| `runContextCompactionHarness` | Repeated-run stability measurement |

Full signatures:
[`@caveman-ai/agent/compaction`](../reference/api/agent/compaction.md).

## The stability harness

The harness owns fixtures and validation; the adapter owns the model and the
transport. That split keeps provider credentials explicit and stops test code
from inheriting ambient secrets.

```ts
import {
  runContextCompactionHarness,
  type ContextCompactionSummarizer,
} from "@caveman-ai/agent/compaction";

const summarize: ContextCompactionSummarizer = async (request) =>
  explicitClient.complete({
    messages: [...request.messages, { role: "user", content: request.instruction }],
    maxTokens: 2_048,
  });

const report = await runContextCompactionHarness(fixture, summarize, {
  repetitions: 20,
});
if (!report.stable) throw new Error(report.failures.join("\n"));
```

The report separates critical-anchor recall, weighted recall, exact-recovery
coverage, compression ratio, and per-round transition validity. It claims
neither verified savings nor semantic superiority.

A useful model-backed corpus includes delayed constraints, changed decisions,
exact paths and commands, tool injection, interrupted work, and tool-call state
changes — at least 20 independent repetitions per candidate, with an
uncompacted control and equal input/output budgets.

## Where compaction may not run

Compaction attaches at the **adapter** model boundary, never at the wire
transport. Rewriting messages under a framework would leave the framework's own
history describing a transcript the model never saw; it would then rebuild the
next request from stale state and silently undo the compaction, or send tool
results whose calls no longer exist. See
[Adapters and the wire transport](16-adapters-and-wire.md).

Full contract:
[`packages/agent/docs/compaction.md`](../../packages/agent/docs/compaction.md).
