# Agent memory

`@caveman-ai/agent/memory` provides one lightweight memory engine for SDK
agents, coding sessions, Pebble, and arbitrary agent workflows.

## Fast path

Coding agent:

```ts
import { createCodingAgent, startCodingSession } from "@caveman-ai/agent/code";

const agent = createCodingAgent({ memory: true });
const session = await startCodingSession(agent);
```

Pebble uses same option and implementation:

```ts
import { createPebbleAgent } from "@pebble-agent/libpebble";

const session = await createPebbleAgent({ memory: true }).createSession();
```

Memory is opt-in because it durably stores conversation-derived data. `true`
creates one tenant/agent/namespace-scoped local engine and reuses it for session.
`session.close()` flushes background work.

Generic SDK agents stay declarative:

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

await run(support, "Help with a refund", {
  memory: { tenant: "tenant-1", engine },
});
```

Reuse one engine across turns. One-shot run without engine still gets explicit
memory tools, but ambient work stays disabled so no task survives after return.

## Runtime shape

One engine owns four small paths:

1. `beginTurn()` returns finished recall from prior turn and queues current
   retrieval. Embedding or sidecar latency never blocks main model.
2. `endTurn()` queues assistant turn for session search and extraction.
3. Explicit `remember`, `search`, `searchSessions`, `forget`, and `link` methods
   support active workflows. Native agents expose remember, memory search, and
   session search as framework tools.
4. `endSession()` flushes pending work, extracts remaining turns, and runs
   optional consolidation pass.

Passive recall is one turn behind by design. Recall enters immediately before
current user message in model-visible live context. It never mutates append-only
conversation history or provider-cache-stable system prefix.

Every injected block says memory is `inferred`, potentially stale, and must be
checked against current user intent, code, tools, and runtime evidence.

## Retrieval and graph

Every long-term memory and session turn may carry a vector. Vectors store stable
adapter identity and dimensions, so different embedding spaces are never
compared. Local JSON uses normalized int8 quantization plus base64 instead of
large floating-point arrays.

Recall combines vector cosine similarity with lexical overlap, then expands
bounded seed hits through `relates_to`, `supersedes`, `contradicts`, and
`derived_from` edges. Expansion depth caps at three and defaults to one. Token
and result budgets apply after ranking.

Default embedding is dependency-free sparse lexical vector. It gives useful
zero-setup cosine retrieval but is not described as semantic. Use embedding
adapter for semantic recall:

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

Adapter uses `fetch` and adds no provider SDK. It never reads ambient API-key
environment variables. Local or hosted OpenAI-compatible embedding endpoints
use same seam.

## Sidecar and ambient extraction

No extra model call occurs unless application supplies `MemorySidecarAdapter`.
Optional methods:

- `review`: select candidate IDs and optionally add bounded deeper-retrieval
  context before passive injection;
- `extract`: turn bounded topic segment into durable typed memories;
- `consolidate`: propose missing facts or explicit conflict/supersession links.

`completionMemorySidecar()` adapts any structured-output model through one
`complete()` callback. It requires strict bounded JSON, accepts only existing
candidate IDs, and fails closed on malformed output. Automatic extraction runs
after configured assistant-turn count, on semantic drift, and on session end.
Deep consolidation runs after configured write count and at session close.

Consolidation is reversible: records remain as inactive evidence and graph edges
record supersession. Conflicting memories remain inspectable. Sidecar output
never becomes verified policy or verified savings.

## Any workflow

Framework adapters need no memory-specific agent implementation:

```ts
import { createMemoryWorkflow } from "@caveman-ai/agent/memory";

const memory = createMemoryWorkflow(engine, sessionId);
const memoryContext = memory.beforeTurn(userText); // string | undefined, no wait
const answer = await callAgent({ userText, memoryContext });
memory.afterTurn(answer);
await memory.close();
```

Custom stores implement two methods: `read(scope)` and serialized atomic
`update(scope, mutate)`. Built-ins include private atomic file storage and an
in-memory adapter. Postgres, SQLite, vector databases, hosted memory, or
framework-owned persistence stay outside core runtime.

## Privacy and operational limits

- Scope is `(tenant, agentId, namespace)`. Engine/runtime mismatch fails before
  provider spend.
- Local directory and files use `0700` and `0600`; writes use private temporary
  file plus atomic rename.
- Obvious private keys, provider tokens, credential assignments, and access keys
  are refused before explicit memory, session indexing, or sidecar processing.
  Applications can add `allowStore` policy through normal runtime/Pebble config.
- Local cross-process updates remain last-writer-wins. Use transactional adapter
  for concurrent server writers.
- Corrupt local state reads as empty. No corrupt bytes enter prompt.
- Default session index retains 2,000 turns. Recall, graph depth, drafts, tags,
  text, vectors, and sidecar candidate sets are bounded.
- No path claims optimization or financial savings. Recall quality and cost need
  task-level evaluation.

## Evaluation gate

JCode inspired async next-turn recall, vector-seeded graph traversal, explicit
tools, session RAG, and background extraction. Its public architecture is at
<https://github.com/1jehuang/jcode/blob/master/docs/MEMORY_ARCHITECTURE.md>.

Do not promote semantic/graph configuration because retrieval metrics look good.
Compare against exact/path/lexical baseline on representative tasks and report:

- completed-task quality and constraint consistency;
- useful-memory precision/recall and stale/conflict injection rate;
- injected tokens, embedding calls, sidecar calls, latency, and storage growth;
- total provider cost including extraction, verification, and consolidation;
- repeated-session behavior, not one favorable trace.

Graph/vector mode should remain optional until it improves end-to-end outcomes
after full cost.
