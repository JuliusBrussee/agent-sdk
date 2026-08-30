# Caveman Connect in Agent SDK

Status: first-party optional protocol client. `@caveman-ai/agent` owns agent
configuration, bounded invocation, quality policy, and evidence. External
`cave-connectd` owns provider OAuth, credentials, encrypted storage, proxying,
sync execution, and records.

SDK never bundles or copies proprietary Pebble or Connect implementation.

## Smallest integration

```ts
import { agent, auto, createConnect } from "@caveman-ai/agent";

const data = createConnect({
  sources: [{
    id: "work-github",
    provider: "github",
    collect: ["issues"],
    models: ["Issue"],
  }],
});

export default agent({
  id: "issue-triage",
  instructions: "Use connected source data. Never invent missing records.",
  model: auto(),
  tools: [data.tool],
});
```

Authorize provider once:

```bash
caveman-agent connect github
```

Start configured collection from application or deployment job:

```ts
await data.collect("work-github");
```

`collect()` triggers configured syncs and returns daemon acknowledgements. It
does not pretend queued sync is complete. Poll through `connected_data` with
`operation: "sync_status"`, then read records. Recurring schedules are not part
of current MCP protocol; invoke `collect()` from existing scheduler until
Connect exposes audited schedule management.

When source omits `connectionId`, runtime accepts exactly one active saved
connection for provider. Zero or multiple matches fail closed. Set exact id to
remove ambiguity.

## Why prompt cost stays low

One stable tool schema enters provider-visible prefix. Provider catalog, action
schemas, sync schemas, and records stay outside prompt until agent requests
them. Flow:

1. `sources` returns tiny allowlist.
2. `search_syncs` or `search_actions` loads bounded matching metadata.
3. `collect` triggers allowlisted sync.
4. `records` reads exact paginated records.

No retrieval LLM, embeddings, semantic reranker, or automatic summarizer runs
by default. This avoids hidden model spend. Stable schema also preserves
provider cache prefix inside cache epoch.

This can still cost more when retrieval causes extra model turns, collection is
expensive, data is stale, or agent retries after incomplete context. Therefore
token reduction is not savings proof.

## MCP tool discovery

Hosts that need Connect's native tool catalog can read it without building a
second MCP client:

```ts
import { ConnectRuntime } from "@caveman-ai/agent/connect";

const runtime = new ConnectRuntime();
const tools = await runtime.listTools(signal);
```

`listTools()` follows exact MCP `nextCursor` values and returns one detached,
deeply frozen array only after every page passes. It uses same bootstrap,
initialization, child-process timeout, abort, capture, shutdown, and exact
response-ID checks as `call()`.

Discovery fails closed instead of returning a partial catalog when response is
malformed, tool name repeats, cursor cycles, or fixed cap is reached: 32 pages,
1,024 tools, 1 MiB serialized descriptors, 4 KiB cursor, 100,000 JSON nodes,
and depth 64. Tool schemas, metadata, annotations, icons, and execution hints
remain plain data. Annotation values are untrusted interoperability hints; SDK
does not turn them into approval, permission, or admission decisions.

## Quality contract

Default policy:

```ts
quality: {
  maxRecords: 100,
  maxPages: 5,
  maxResultBytes: 24 * 1024,
  incomplete: "refuse",
}
```

Records are never silently summarized or relevance-filtered. Runtime follows
exact daemon cursors. Result carries:

- `complete` — all requested pages consumed;
- `next_cursor` — exact continuation when available;
- `capped_by` — `records`, `pages`, or `bytes`;
- `must_refuse` — true whenever result cannot support completeness claim.

Byte cap never advances cursor past omitted page. Agent must retry with smaller
page or disclose unread data. This trades graceful refusal for no hidden loss.

Actions default deny. Only names in source `actions` execute. Source/provider,
sync, and action identifiers are exact allowlists. `models` is exact when
configured; omit it only when every record model under allowed connection may
be read.

## Honest efficiency test

Compare matched baseline and connected runs using same task cases and grader:

```ts
import { compareConnectEfficiency } from "@caveman-ai/agent/connect";

const comparison = compareConnectEfficiency(baseline, connected, {
  maxQualityRegression: 0,
});
```

Acceptance requires:

- connected task succeeds;
- data is complete;
- quality does not regress beyond declared tolerance;
- provider, retrieval, and collection cost evidence is complete;
- total connected cost is lower after provider calls, retrieval, and
  collection.

Report also shows input-token, retry, quality, and total-cost deltas. Evidence
stays `inferred`; SDK never mints verified savings.

Use total cost:

```text
provider model calls
+ retry/follow-up model calls
+ retrieval/reranking cost
+ collection/sync cost
= task total
```

Count task success separately. Cheapest failed answer is not efficient.

## Security and support truth

- Child process receives explicit non-secret environment allowlist.
- Provider keys and `CAVE_CONNECT_SECRET_KEY` are stripped.
- Secrets never enter model prompt, tool arguments, argv, or SDK receipts.
- Connect runtime is kernel-owned, so default `sandbox: "required"` agents do
  not need unsafe host tool closures.
- Binary resolution uses absolute `CAVE_CONNECT_BIN` or executable found on
  `PATH`, then resolves and validates real file.
- Cataloged, locally connectable, template-covered, and live-certified remain
  separate states. SDK integration does not upgrade provider certification.

Fixed-callback OAuth and webhooks may still need hosted relay/endpoint. Run
`caveman-agent connect doctor --json` for machine-local readiness.
