# Context compaction

`@caveman-ai/agent` compacts only inside a declared token or USD budget. The
runtime applies a fail-closed ladder: exact-recovery eviction, typed summary,
output clamp, then stop. Provider calls and measured usage stay on the run's
ordinary receipt.

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

const result = await run(agent, input, { budget });
```

## Public compaction API

```ts
import {
  contextSummarySources,
  parseContextSummary,
  runContextCompactionHarness,
  summarizationInstruction,
  validateContextSummaryTransition,
} from "@caveman-ai/agent/compaction";
```

`cave.context-summary.v2` adds generation and source-grounded anchors to the
existing structured handoff. Runtime accepts a capsule only when:

- schema parses;
- generation increments exactly;
- required user sources are covered;
- source IDs and SHA-256 digests match;
- tool content cannot mint critical policy;
- every prior critical anchor survives byte-identically, unless a later current
  user source grounds a new critical anchor with an explicit `supersedes`
  edge;
- root user intent and self-contained recent tail remain verbatim;
- rewritten context is smaller.

One paid summary remains default. Structural support for repeated compaction is
tested, but a higher default needs repeated live-model semantic evidence.

## Live-model stability harness

Harness owns fixtures and validation. Adapter owns model and transport. This
keeps provider credentials explicit and prevents test code from inheriting
ambient secrets.

```ts
import {
  runContextCompactionHarness,
  type ContextCompactionSummarizer,
} from "@caveman-ai/agent/compaction";

const summarize: ContextCompactionSummarizer = async (request) => {
  // Call chosen provider/local model through an explicit client here.
  // Give it request.messages plus request.instruction.
  return explicitClient.complete({
    messages: [
      ...request.messages,
      { role: "user", content: request.instruction },
    ],
    maxTokens: 2_048,
  });
};

const report = await runContextCompactionHarness(fixture, summarize, {
  repetitions: 20,
});
if (!report.stable) throw new Error(report.failures.join("\n"));
```

Report separates critical-anchor recall, weighted recall, exact-recovery
coverage, compression ratio, and per-round transition validity. It does not
claim verified savings or semantic superiority.

Recommended model-backed corpus includes delayed constraints, changed
decisions, exact paths/commands, tool injection, interrupted work, tool-call
state changes, and at least 20 independent repetitions per candidate. Keep an
uncompacted control and equal input/output budgets.
