# Memory

Durable, opt-in agent memory: async next-turn recall, session search, explicit
tools, optional embeddings and graph traversal, reversible consolidation, TTL,
and tenant isolation. It is opt-in because it durably stores
conversation-derived data.

## Fast path

Coding agent and Pebble need one option:

```ts
const agent = createCodingAgent({ memory: true });
const session = await startCodingSession(agent);
// session.close() flushes background work
```

`true` creates one tenant/agent/namespace-scoped local engine and reuses it for
the session.

## Declarative path

```ts
import { agent, auto, createMemoryEngine, memory, run } from "@caveman-ai/agent";

const support = agent({
  id: "support",
  instructions: "Resolve support requests.",
  model: auto(),
  memory: memory({ namespace: "support" }),
});

const engine = createMemoryEngine({
  scope: { tenant: "tenant-1", agentId: "support", namespace: "support" },
  ttlMs: 30 * 86_400_000,
});

await run(support, "Remember that I prefer email updates.", {
  memory: { tenant: "tenant-1", engine },
});
```

Reuse one engine across turns. A one-shot run without an engine still gets the
explicit memory tools, but ambient work stays disabled so no task survives the
return.

### `memory()` options

| Option | Default | Notes |
| --- | --- | --- |
| `namespace` | required | Third component of the scope key |
| `ttl` | `"30d"` | Duration string |
| `recallBudget` | `800` tokens | Ceiling on injected recall |
| `provenance` | `"local"` | Only `local` is supported |
| `consent` | ambient policy | Only `"local_only"` is supported |
| `ambient` | enabled | `false` disables background work entirely |

A shared-backend configuration is refused at `memory()` construction time, not
at tool-call time.

## Scope

Entries are keyed by **(tenant, agentId, namespace)**. Two definitions declaring
the same namespace in one process never see each other's memories, and an
embedding server isolates tenants. Engine/runtime scope mismatch fails before
provider spend.

`RunOptions.memory` controls location and tenancy:

| Field | Default |
| --- | --- |
| `root` | `CAVE_AGENT_MEMORY_ROOT`, else `~/.caveman/agent-memory` |
| `tenant` | single-tenant |
| `engine` | none (explicit tools only) |

## Runtime shape

One engine owns four paths:

1. **`beginTurn()`** returns finished recall from the prior turn and queues the
   current retrieval. Embedding or sidecar latency never blocks the main model.
2. **`endTurn()`** queues the assistant turn for session search and extraction.
3. **Explicit methods** — `remember`, `search`, `searchSessions`, `forget`,
   `link` — back the framework tools `cave_memory_remember`,
   `cave_memory_search`, and `cave_memory_session_search`.
4. **`endSession()`** flushes pending work, extracts remaining turns, and runs
   the optional consolidation pass.

Passive recall is **one turn behind by design**. It enters the live context
immediately before the current user message — never the append-only conversation
history, never the cache-stable system prefix. Every injected block states that
memory is `inferred` and potentially stale, and that current user intent, code,
tools, and runtime evidence win.

## Retrieval, vectors, and the graph

Recall combines vector cosine similarity with lexical overlap, then expands
bounded seed hits through `relates_to`, `supersedes`, `contradicts`, and
`derived_from` edges. Expansion depth defaults to 1 and caps at 3. Token and
result budgets apply after ranking.

The default embedding is a dependency-free **sparse lexical** vector. It gives
useful zero-setup cosine retrieval and is deliberately not described as
semantic. Vectors carry stable adapter identity and dimensions, so different
embedding spaces are never compared. Local JSON stores normalized int8 plus
base64, not floating-point arrays.

For semantic recall, supply an adapter:

```ts
import {
  createMemoryEngine,
  openAICompatibleMemoryEmbedding,
} from "@caveman-ai/agent/memory";

const engine = createMemoryEngine({
  scope: { tenant: "_", agentId: "support", namespace: "support" },
  ttlMs: 30 * 86_400_000,
  embedding: openAICompatibleMemoryEmbedding({
    baseURL: "https://api.openai.com/v1",
    model: "text-embedding-3-small",
    apiKey: explicitApiKey,
  }),
});
```

The adapter uses `fetch`, adds no provider SDK, and never reads ambient API-key
environment variables.

## Sidecars

No extra model call happens unless you supply a `MemorySidecarAdapter`:

| Method | Purpose |
| --- | --- |
| `review` | Select candidate IDs and optionally add bounded deeper-retrieval context before passive injection |
| `extract` | Turn a bounded topic segment into durable typed memories |
| `consolidate` | Propose missing facts or explicit conflict/supersession links |

`completionMemorySidecar()` adapts any structured-output model through one
`complete()` callback. It requires strict bounded JSON, accepts only existing
candidate IDs, and fails closed on malformed output
(`cave_memory_sidecar_extract_invalid`, `cave_memory_sidecar_review_invalid`).

Automatic extraction runs after a configured assistant-turn count, on semantic
drift, and at session end. Deep consolidation runs after a configured write
count and at session close. Consolidation is **reversible**: records remain as
inactive evidence, graph edges record supersession, and conflicting memories
stay inspectable.

## Any workflow

Framework adapters need no memory-specific agent implementation:

```ts
import { createMemoryWorkflow } from "@caveman-ai/agent/memory";

const memoryFlow = createMemoryWorkflow(engine, sessionId);
const memoryContext = memoryFlow.beforeTurn(userText); // string | undefined, no wait
const answer = await callAgent({ userText, memoryContext });
memoryFlow.afterTurn(answer);
await memoryFlow.close();
```

## Storage

Custom stores implement two methods: `read(scope)` and a serialized atomic
`update(scope, mutate)`. Built-ins are a private atomic file store
(`createFileMemoryAdapter`, `MemoryStoreConfig`) and an in-memory adapter.
Postgres, SQLite, vector databases, and hosted memory stay outside core.

Local persistence details:

- Directories `0700`, files `0600`; writes are private temp file plus atomic
  rename.
- In-process writes serialize per file; across processes, atomic rename prevents
  torn files with last-writer-wins on concurrent update.
- Corrupt local state reads as empty — no corrupt bytes enter a prompt.
- Expired records become inactive reversible evidence.

Server deployments that need multi-writer transactions supply a storage adapter.

## Privacy and limits

- Obvious private keys, provider tokens, credential assignments, and access keys
  are refused before storage, indexing, or sidecar processing.
- Applications can add an `allowStore` policy through normal runtime config.
- Default session index retains 2,000 turns. Recall, graph depth, drafts, tags,
  text, vectors, and sidecar candidate sets are all bounded.
- Recalled memory is basis `inferred`. Nothing here is ever a saving.

## Evaluating whether to enable it

Do not promote semantic or graph configuration because retrieval metrics look
good. Compare against an exact/path/lexical baseline on representative tasks and
report completed-task quality, useful-memory precision/recall, stale and
conflicting injection rate, injected tokens, embedding and sidecar calls,
latency, storage growth, total provider cost including extraction and
consolidation, and repeated-session behavior.

Full contract: [`packages/agent/docs/memory.md`](../../packages/agent/docs/memory.md).
API: [`@caveman-ai/agent/memory`](../reference/api/agent/memory.md).
