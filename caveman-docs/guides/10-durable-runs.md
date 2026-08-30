# Durable runs

Opt-in crash-recoverable execution. The journal is the state; the process is
replaceable.

```ts
const result = await run(definition, "Analyze case 42", {
  durable: { runId: "case-42-analysis-1" },
  budget: { maxTokens: 120_000 },
});
```

## `runId` is the idempotency key

The caller assigns it. The same `runId` always refers to the same logical run.

| Resubmitting the same `runId` | What happens |
| --- | --- |
| Run finished | The journaled result is returned. Nothing is spent |
| Run failed terminally | The same error is returned. Nothing is spent |
| Run was interrupted (crash or abort) | It resumes from its last journaled boundary |
| Run is in flight elsewhere | The per-run lock refuses a second driver (`cave_durable_run_locked`) |

Format: `[A-Za-z0-9][A-Za-z0-9._-]{0,127}` — filename-safe. Invalid ids fail with
`cave_durable_run_id_invalid`.

## What is journaled, and when

The ledger is event-sourced and fine-grained:

- `call_started` — **fsynced before every provider call** (root, subagents
  through the inherited execution-context journal, and compaction summarizers).
- `call_settled` — after the call returns.
- Conversation state — checkpointed per turn, so the turn is durable before the
  next call.

Resume preloads the meter with journaled settlements, so settled money is never
re-reserved and never lost.

## The at-least-once ceiling

An intent with no settlement means the provider may have billed money this
ledger could not see. That surfaces as
`receipt.resume.possibleDoubleCountCalls` — never silently. Those calls appear
in **no other figure** on the receipt.

## How resume works

Resume rebuilds to the last boundary ending in a user or tool-result message and
re-enters through `pi.continue()`, so the prompt is never asked twice. A lost
partial turn is re-driven with its prior spend kept
(`resume.discardedPartialTurn`).

Pi's `state.messages` is append-only, so a compaction's replacement context
lives only in the loop's local view. A resume therefore rebuilds the
**uncompacted** transcript, and compaction counters are deliberately not
restored: the resumed run may pay — metered and journaled — to compact it again.
The budget is the real bound.

An abort is the deliberate twin of a crash and stays resumable.

## Fail-closed identity

The journal must match the run being resumed:

| Refusal | Meaning |
| --- | --- |
| `cave_durable_definition_changed` | The definition digest drifted |
| `cave_durable_input_mismatch` | A different input under the same `runId` |
| `cave_durable_budget_changed` | The budget contract drifted |
| `cave_durable_conversation_mismatch` | Session identity drifted |
| `cave_durable_journal_corrupt` | Unreadable or unknown journal events |
| `cave_durable_journal_limit` | Journal exceeded its bound |
| `cave_durable_run_locked` | Another live process holds the per-run lock |

Journal identity includes the **build and plan digests**, so one run id cannot
replay under another build.

## v1 scope gates

Each of these fails closed:

- No `conversation` — durable runs own their own state.
- No `maxCostUsd` — use `budget`.
- Root runs only.
- Breaker windows and `previousSummary` restart on resume.

Synthesized refusal, error, and aborted turns are never journaled as state, and
an error turn without a live reservation journals no settlement — a phantom zero
settle would hide a double count.

## Stores

```ts
export interface DurableStore {
  load(runId): Promise<readonly string[]>;
  append(runId, data: string): Promise<void>;
  acquire(runId): Promise<() => Promise<void>>;
  close(runId): Promise<void>;
  list?(): Promise<readonly string[]>;
}
```

| Store | Use when |
| --- | --- |
| `DiskDurableStore` (default) | The instance has a volume that survives restarts. Journals live under `<rootDir>/.caveman/runs/durable/<runId>/`, `0700`/`0600`, because they necessarily hold message content |
| `HttpDurableStore` | The instance does not — container platforms, autoscaled fleets |
| Your own | Anything else: a database, an object store |

`list()` is optional. A store that cannot enumerate is still a valid journal
store; it just cannot back crash recovery, and the recovery sweep reports
`listable: false` rather than pretending the store is empty.

Two deliberate refusals:

- An append is **never retried** — a duplicated settlement is silently wrong
  money, so the run fails and the resume re-drives instead.
- Losing the lock lease **poisons the store** for that run, because this process
  can no longer prove it is the only driver.

### `HttpDurableStore`

```ts
new HttpDurableStore({
  url: "https://journal.example",   // https required outside localhost
  token: journalToken,              // required; an unauthenticated journal is an open ledger
  fetchFn,                          // optional injectable transport
  lockTtlMs: 30_000,                // holder renews at a third of it
  requestTimeoutMs: 10_000,
});
```

The endpoint must implement six routes:

```text
GET    {base}/runs                  → {"runIds": [...]}
GET    {base}/runs/{id}/journal     → raw journal text (404 = none)
POST   {base}/runs/{id}/journal     → 204 once the bytes are DURABLE
POST   {base}/runs/{id}/lock        → {"token","expiresAt"} | 409 held
POST   {base}/runs/{id}/lock/renew  → 204 | 409 lease lost
DELETE {base}/runs/{id}/lock        → 204
```

`packages/agent/hosting/cloudflare/worker.ts` is a complete implementation
(Durable Object journal).

## Inspecting a journal

```ts
import { durableRunSummary, durableInputIsReplayable } from "@caveman-ai/agent";

const summary = durableRunSummary(await store.load(runId));
// { status: "missing" | "pending" | "completed" | "failed", … }
```

`durableRunSummary` is the read-only view: it answers "is this run finished, and
with what" for a status endpoint or a recovery sweep, and deliberately cannot
resume anything. Every resume goes through the internal journal analysis, which
fails closed on drifted definition, input, or budget.

`durableInputIsReplayable(input)` is false for the multimodal digest form: a
multimodal run journals a digest, not the content, so only a caller still
holding the original input can resume it.

Full API: [`@caveman-ai/agent/durable`](../reference/api/agent/durable.md).
