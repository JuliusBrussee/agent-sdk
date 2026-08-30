# Portability: where Caveman's optimizations actually attach

Caveman's value is its economics — a real request ceiling, exact usage
accounting, provider-native cache hints, compaction, and routing. Historically
those lived only inside the native runtime, and the framework adapters under
`packages/adapters/*` carried lifecycle events and usage observation. That made
the adapters honest but thin: a Vercel AI SDK or Mastra user got telemetry, not
optimization.

This document is the positioning: **which layer each optimization attaches to,
and why.** It is a boundary decision, not a roadmap.

## The two seams

There are exactly two places Caveman can attach to a foreign framework.

### 1. The wire (`fetch`) — `@caveman-ai/agent/wire`

Every framework in this repo's adapter set lets its provider client take a
custom `fetch`. The cache planner already operates on provider-native JSON
bodies and `budget.ts` already reserves and settles per call, so both work here
untouched.

This layer scales by **provider**, not by framework. One implementation covers
Vercel AI SDK, Mastra, OpenAI Agents, LangGraph, Cloudflare Agents, Strands, and
anything else that speaks HTTP to Anthropic or OpenAI — including the two
adapters whose manifests declare `modelInterception: "unsupported"`.

```ts
import { createAnthropic } from "@ai-sdk/anthropic";
import { createCavemanTransport } from "@caveman-ai/agent/wire";

const caveman = createCavemanTransport({ budget: { maxTokens: 2_000_000 } });
const anthropic = createAnthropic({ fetch: caveman.fetch });
// caveman.meter.settled is exact, provider-reported spend.
```

That is the whole integration. No adapter, no wrapper, no per-framework code.

### 2. The adapter (`modelBoundary`) — `packages/adapters/*`

`modelBoundary.prepare(request, context)` returns a **replacement** request that
the adapter sends to the provider, so it is already a mutation seam, not an
observation one. It is the right home for anything that must stay in sync with
framework-owned state.

## What attaches where

| Optimization | Seam | Per-framework code | Why |
|---|---|---|---|
| Request ceiling (reserve / clamp / deny) | wire | none | Needs only bytes and the provider's own identity |
| Exact usage accounting | wire | none | The provider reports it in the response body |
| Provider-native cache hints | wire | none | The planner already edits wire bodies |
| Compaction | adapter | small | Rewrites messages; must not desync framework state |
| Model routing | adapter | small | Cross-provider swaps change response handling |

The split is load-bearing. Compaction at the wire would leave the framework's
own message history describing a transcript the model never saw — the framework
would then rebuild the next request from stale state and silently undo the
compaction, or worse, send tool results whose calls no longer exist. That class
of bug is why `src/compaction.ts` is documented as *the only place in this
package that rewrites model-visible context*.

## What the wire layer honestly delivers today

**Unblocked and portable now:**

- **Request ceiling.** Every call reserves its worst case before it leaves. A
  remainder that cannot fund the full output allowance clamps the outgoing
  `max_tokens` down to `OUTPUT_CLAMP_FLOOR_TOKENS`; below that the call is
  refused before any provider spend.
- **Exact accounting.** Provider-reported usage settles the meter, merged across
  Anthropic's split `message_start` / `message_delta` events and OpenAI's final
  chunk. A response whose usage cannot be measured settles at the **full
  reserve**, never at zero.

**Gated:**

- **Cache hints** default to `cache: "gated"`, which mirrors `runtime.ts`
  exactly: only grammars proven against a live provider leave the SDK, and today
  that is the OpenAI affinity routing key alone. The Anthropic and Bedrock
  splices are byte-parity-tested against the Go engine's 41 fixtures but have
  never been sent to a live endpoint from this SDK (#225). `cache: "all"` is an
  explicit, documented opt-in to unproven-live behavior. It is never a default,
  and closing #225 is what makes it one.

**Not built:**

- Bedrock, whose URL carries model and region and which needs SigV4-aware
  re-signing after any body edit.
- Azure OpenAI and other rehosted endpoints. An unrecognized host passes
  through untouched rather than guessing a provider grammar.

## Honesty constraints this layer inherits

- No savings claim of any kind. The planner's `claimBasis` is at most
  `"inferred"` and `verifiedSavingsUsd` is always zero.
- `ModelUsage.cost` is priced only when every count is known, reasoning
  included. Anthropic never breaks the reasoning split out, so its records are
  explicitly `unknown`-cost. The meter can still settle exactly, because
  reasoning is a subset of output and both extremes of the unknown split price
  identically when the catalog's reasoning and output rates match — when they
  do not, the cost stays unknown and the call settles at its reserve.
- The wire cannot see which credential pays, so it cannot tell a metered API key
  from a subscription. `maxTokens` is the honest default; `maxUsd` is the
  caller asserting that this transport's key is billed in dollars.
- Only one field is ever defaulted to zero: OpenAI's cache-write count, because
  OpenAI has no cache-write class at all (its catalog rate is `null`). Every
  other absent count stays `null`.

## Limits worth knowing before you rely on it

- **Denial is a transport error.** Refusing a call surfaces to the framework as
  a failed request, and the framework's own retry policy decides what happens
  next. The clean stop is still host-side: the caller owns the `AbortController`
  and aborts when `transport.meter.remaining()` runs out.
- **Streaming settles asynchronously.** The scanning branch of the teed response
  finishes after the caller's last read, so the meter is exact but trails the
  stream's end by a tick.
- **Tools stay observation-only.** No adapter can deny a tool call today; the
  `toolObservation` capability is named for what it is. Real tool gating needs a
  per-framework tool-wrapping seam and is a separate axis from this one.

## Source

- `packages/agent/src/wire.ts` — the transport.
- `packages/agent/tests/wire.runtime.mjs` — ceiling, clamp, accounting, cache
  gate, epoch behavior.
- `packages/adapters/vercel-ai-sdk/tests/wire.test.mjs` — end-to-end through a
  real `ai@7.0.84` agent loop.
