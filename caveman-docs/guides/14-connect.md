# Caveman Connect

One stable tool that exposes allowed provider data (GitHub, Slack, …) without
putting a provider catalog in every prompt.

**Boundary:** `@caveman-ai/agent` owns agent configuration, bounded invocation,
quality policy, and evidence. External `cave-connectd` owns provider OAuth,
credentials, encrypted storage, proxying, sync execution, and records. The SDK
never bundles or copies that implementation.

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

Authorize once:

```bash
caveman-agent connect github
```

Then trigger collection from your application or a deployment job:

```ts
await data.collect("work-github");
```

`collect()` triggers configured syncs and returns daemon acknowledgements. It
does **not** pretend a queued sync is complete. Poll through `connected_data`
with `operation: "sync_status"`, then read records. Recurring schedules are not
part of the current MCP protocol — call `collect()` from your existing scheduler
until Connect exposes audited schedule management.

When a source omits `connectionId`, the runtime accepts exactly one active saved
connection for the provider. Zero or several matches fail closed
(`cave_connect_source_not_allowed` and friends). Set an exact id to remove the
ambiguity.

## Why the prompt stays small

One stable tool schema enters the provider-visible prefix. The provider catalog,
action schemas, sync schemas, and records stay outside the prompt until the
agent asks:

1. `sources` returns a tiny allowlist.
2. `search_syncs` / `search_actions` load bounded matching metadata.
3. `collect` triggers an allowlisted sync.
4. `records` reads exact paginated records.

No retrieval LLM, embedding, semantic reranker, or automatic summarizer runs by
default, so there is no hidden model spend. The stable schema also preserves the
provider cache prefix inside a cache epoch.

This can still cost **more** when retrieval causes extra model turns, collection
is expensive, data is stale, or the agent retries after incomplete context.
Token reduction is not savings proof.

## Quality contract

```ts
quality: {
  maxRecords: 100,
  maxPages: 5,
  maxResultBytes: 24 * 1024,
  incomplete: "refuse",
}
```

Records are never silently summarized or relevance-filtered. The runtime follows
exact daemon cursors, and every result carries:

| Field | Meaning |
| --- | --- |
| `complete` | All requested pages were consumed |
| `next_cursor` | Exact continuation when available |
| `capped_by` | `records`, `pages`, or `bytes` |
| `must_refuse` | True whenever the result cannot support a completeness claim |

The byte cap never advances the cursor past an omitted page. The agent must
retry with a smaller page or disclose the unread data. This trades graceful
refusal for no hidden loss.

## Actions default to deny

Only names listed in a source's `actions` execute. Source/provider, sync, and
action identifiers are exact allowlists. `models` is exact when configured; omit
it only when every record model under the allowed connection may be read.

### Bound arguments

An allowlisted action name still leaves every argument to the model, so
`post-message` could reach any channel the connection can reach. Fix the
destination in configuration:

```ts
actions: [{ name: "post-message", bind: { channel: "C0456" } }]
```

Bound keys are set from config **after** model input. Model input that sets a
bound key fails with `cave_connect_action_bind_conflict` rather than being
silently overridden, so a redirect attempt fails instead of appearing to succeed
somewhere else. Bind values stay serializable scalars (string, number, boolean,
null), at most 32 keys, and never carry credentials — Connect owns those. The
tool description and `sources` name each bound key so the model omits it.

## Retries after an unknown outcome

A timeout, an abort, or a result that exceeded `maxResultBytes` leaves the side
effect possibly applied. The runtime derives a key from source, provider,
action, and the exact merged arguments, and refuses an identical repeat with
`cave_connect_action_outcome_unknown`. Verify whether the earlier call ran before
repeating it; a different payload is a different call and still executes. Only a
daemon-reported failure is known not to have applied and stays retryable.

The guard is process-scoped and bounded to the 256 most recent unknown outcomes.
`cave-connectd` owns action execution, so the SDK claims no daemon-side
deduplication.

## MCP tool discovery

```ts
import { ConnectRuntime } from "@caveman-ai/agent/connect";

const runtime = new ConnectRuntime();
const tools = await runtime.listTools(signal);
```

`listTools()` follows exact MCP `nextCursor` values and returns one detached,
deeply frozen array only after every page passes. It uses the same bootstrap,
initialization, child-process timeout, abort, capture, shutdown, and exact
response-ID checks as `call()`.

Discovery fails closed instead of returning a partial catalog when the response
is malformed, a tool name repeats, a cursor cycles, or a fixed cap is reached:
**32 pages, 1,024 tools, 1 MiB serialized descriptors, 4 KiB cursor, 100,000
JSON nodes, depth 64.** Tool schemas, metadata, annotations, icons, and execution
hints stay plain data — annotation values are untrusted interoperability hints,
never approval, permission, or admission decisions.

## Honest efficiency comparison

```ts
import { compareConnectEfficiency } from "@caveman-ai/agent/connect";

const comparison = compareConnectEfficiency(baseline, connected, {
  maxQualityRegression: 0,
});
```

Acceptance requires the connected task to succeed, data to be complete, quality
not to regress beyond the declared tolerance, provider/retrieval/collection cost
evidence to be complete, and total connected cost to be lower **after** provider
calls, retrieval, and collection:

```text
provider model calls
+ retry/follow-up model calls
+ retrieval/reranking cost
+ collection/sync cost
= task total
```

Evidence stays `inferred`.

## Security

- The child process receives an explicit non-secret environment allowlist.
- Provider keys and `CAVE_CONNECT_SECRET_KEY` are stripped.
- Secrets never enter the model prompt, tool arguments, argv, or SDK receipts.
- The Connect runtime is kernel-owned, so default `sandbox: "required"` agents
  need no unsafe host tool closures.
- Binary resolution uses an absolute `CAVE_CONNECT_BIN` or an executable found
  on `PATH`, then resolves and validates the real file.
- Cataloged, locally connectable, template-covered, and live-certified are
  separate states. SDK integration never upgrades provider certification.

Fixed-callback OAuth and webhooks may still need a hosted relay. Check local
readiness with:

```bash
caveman-agent connect doctor --json
```

Full contract:
[`packages/agent/docs/connect.md`](../../packages/agent/docs/connect.md).
API: [`@caveman-ai/agent/connect`](../reference/api/agent/connect.md).
