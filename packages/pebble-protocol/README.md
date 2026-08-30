# @pebble-agent/protocol

> **FROZEN** — this contract was frozen at version **0.1.0** (spine unit S2).
> Every other Pebble workstream compiles against these types only. Any change to
> the shape, field names, field types, enum membership, ordering constraints, or
> meaning of anything exported here is **BREAKING** and requires a new major
> version (see [Versioning policy](#versioning-policy)). The same notice is
> burned into `src/index.ts` as a banner comment.
>
> Savings vocabulary is part of this contract: savings are **inferred** until a
> holdout measures them; surfaces show route **reasons**, never savings deltas;
> unknown pricing renders as "unknown" (`costUsd: null`), never as $0.

The PEBBLE wire and storage contract, version 1:

- **Turn events** — one discriminated union of 19 kinds, flat JSON objects.
- **Session entries** — the tree-JSONL storage node schema.
- **JSONL-RPC framing** — byte-accurate stdio framing plus JSON-RPC envelopes.
- **ACP mapping** — how Pebble events render under the Agent Client Protocol.

Package: Apache-2.0, `private: true`, **zero runtime dependencies**, hand-rolled
validators, strict TypeScript with erasable syntax only. Engines: `node >=22.19`
(native type stripping runs sources directly), authored for `bun >=1.4.0`.

```bash
npm install        # dev deps only (typescript, @types/node)
npm run lint       # tsc --noEmit over src + tests
npm test           # node --test 'tests/*.test.ts'
npm run build      # tsc → dist/
```

## Wire model

Pebble runs in two modes over the same event stream:

- **print mode**: each turn event is one JSONL frame on stdout, bare.
- **RPC mode**: requests/responses follow JSON-RPC 2.0; turn events ride as
  notifications on method `pebble/event` whose `params` IS the event object.

## Envelope

Every event carries exactly these envelope fields, before `kind` and payload:

| Field | Type | Rule |
|---|---|---|
| `v` | `1` | Protocol version. Literally `1` inside this major line. |
| `seq` | number | Producer-assigned, monotonically increasing, gap-free per session stream, starting at 0. Stateless shape guards cannot enforce continuity; `TurnEventSequenceValidator` and `SessionEventSequenceCoordinator` reject gaps, duplicates, and session changes. |
| `ts` | string | RFC 3339 / ISO 8601 timestamp at emission; UTC recommended (`2026-08-25T09:30:00.000Z`). |
| `sessionId` | string | Non-empty session identifier. |

Canonical serialization is compact JSON with keys in schema order
(`v, seq, ts, sessionId, kind, …payload`) followed by `\n`. Golden fixtures fix
this order; byte-stable round-trips depend on it. Validators tolerate unknown
extra properties (additive-minor policy) but reject every documented-field
violation.

Canonical key order matters for producers that hash or diff frames; it is not
semantically enforced on decode.

## Event catalog (19 kinds)

| kind | payload fields | producer contract |
|---|---|---|
| `turn.start` | — | Exactly one per producer turn. |
| `turn.end` | `stopReason` | Authoritative turn outcome. Enum below. |
| `delta.text` | `text` | Streaming assistant text; consumers concatenate, never rewrite. |
| `delta.thinking` | `text` | Streaming reasoning, rendered distinctly from text. |
| `tool.start` | `id`, `name`, `argsSummary` | Tool invocation begins; `id` unique per session. `argsSummary` may be empty. |
| `tool.update` | `id`, `delta` | Progress text from a running tool. |
| `tool.end` | `id`, `status`, `detail?` | Terminal tool state. `status ∈ completed \| failed \| cancelled`. Failed tools stay folded in UIs. |
| `usage` | `usage` | Token/cost accounting for calls that already settled. See honesty rules. |
| `stage.open` | `id`, `label` | Sliding-window narration opens a stage (2–5 stages/turn). |
| `stage.rewrite` | `id`, `label` | Retitles the open stage in place. |
| `stage.close` | `id` | Stage closes (completed, not failed). |
| `error` | `message`, `retryable: false` | **Post-retry ONLY.** Emitted after the retry budget is exhausted; one transient 429 must never paint N red blocks downstream. |
| `permission.request` | `id`, `tool`, `plainLanguage`, `detail?` | **Legacy schema-only compatibility data.** Opaque to validators/coordinators; never opens a lifecycle or triggers a request. |
| `permission.resolve` | `id`, `decision` | **Legacy schema-only compatibility data.** `decision ∈ allow-once \| allow-session \| deny`; no operational effect. |
| `queue.changed` | `queued`, `heldAfterInterrupt` | Kernel-owned queue state (steering, typing-while-streaming, interrupt-pause). |
| `checkpoint.created` | `ref`, `n` | Checkpoint landed; `ref` opaque, `n` = running count. |
| `route.decided` | `model`, `reason`, `signals[]` | Structural routing decision. Surfaces render REASONS — never savings deltas. |
| `budget.stopped` | `estimateUsd`, `leftUsd`, `message` | Budget ceiling hit; stopped instead of spending past the cap. |
| `session.compacting` | `firstKeptEntryId?` | Compaction ran; oldest surviving original entry id when present. |

### stop_reason enum (EXACTLY)

```
end_turn | awaiting_input | awaiting_approval | budget_paused | interrupted | error
```

Producers must not invent synonyms; consumers treat unknown values as protocol
violations.

`awaiting_approval` remains frozen legacy vocabulary only. Caveman-owned
runtimes do not implement approval or permission mechanisms.

## Stateful sequence validation

`TurnEventSequenceValidator` validates one complete turn from a caller-selected
`firstSeq`. `SessionEventSequenceCoordinator` validates a complete session from
sequence zero, composes one turn validator at a time, and enforces tool-call-id
uniqueness across turns. Both return detached frozen evidence and stay poisoned
after any error. Memory is bounded by explicit open-lifecycle, seen-identity,
and UTF-8 identity-byte caps; completed turn bodies are not retained.

Legacy `permission.*` frames receive only normal event-shape validation. Their
ids and decisions remain opaque and create no state in either validator.

### Usage honesty rules

- `usage.costUsd` is a measured USD amount, or **`null` when no public-catalog
  price exists**. `null` means **unknown** — consumers MUST render "unknown",
  never "$0 spent".
- Unknown model ids stay verbatim; limits for unknown models display "unknown",
  never guessed values.
- Route decisions surface reasons/signals. Nothing in this protocol may claim
  verified savings; savings remain *inferred* until measured against a holdout,
  and per-day numbers stay per-day verbatim.

## Session entries (`SessionEntry`)

```jsonc
{
  "id": "ent_0001",          // non-empty, unique in store
  "parentId": null,           // null (root) or parent entry id — tree-JSONL branching
  "role": "user",             // user | assistant | system | summary
  "content": "list files",    // full text; deltas already concatenated
  "usage": { … },             // optional; valid Usage object when present
  "ts": "2026-08-25T09:30:00.000Z",
  "v": 1                      // schema version for migrating loaders
}
```

Branching appends an entry pointing at any earlier `parentId` — in place, no
file fork. Compaction writes synthetic entries with `role: "summary"` and points
at the oldest surviving original via `firstKeptEntryId` (mirrored by the
`session.compacting` event). Loaders migrate on read; lines are never rewritten.

## Framing (`framing.ts`)

**THE RULE: frames split STRICTLY on the newline byte `0x0A`.**

- The decoder accumulates raw bytes manually and splits only on `0x0A`. UTF-8
  guarantees multi-byte sequences never contain `0x0A`, so chunk boundaries
  anywhere — including mid-codepoint — are safe.
- **THE NODE READLINE TRAP:** Node's `readline` also splits on U+2028 (LINE
  SEPARATOR) and U+2029 (PARAGRAPH SEPARATOR), while `JSON.stringify` emits both
  RAW inside string values. A readline-based JSONL pipe therefore corrupts any
  frame whose body contains them. This decoder survives such frames intact; the
  golden fixture `fixtures/delta.text.json` contains both characters raw as
  standing proof. Never replace this decoder with readline.
- Blank lines between frames are skipped silently. Anything else unparseable
  throws `ProtocolError`.
- Incomplete trailing data is held until its newline arrives; `end()` throws
  `trailing-bytes` if called with bytes still buffered.
- Invalid UTF-8 fails closed (`bad-utf8`). Frames larger than `maxFrameBytes`
  (default 16 MiB, configurable) fail closed without buffering forever.
- `\r` is not a terminator: CRLF frames parse because trailing `\r` is legal
  JSON whitespace, but re-encoding drops it — byte-stable hops require bare LF.
  A raw CR byte inside a string value fails loudly.

API: `JsonlDecoder` (`push`/`end`/`buffered`/`streamOffset`), `encodeFrame`,
`encodeFrameText`, `decodeFrames`, `ProtocolError` (codes: `bad-json`,
`bad-utf8`, `frame-too-large`, `trailing-bytes`).

```ts
import { JsonlDecoder, encodeFrame } from "@pebble-agent/protocol";
const decoder = new JsonlDecoder();
for await (const chunk of process.stdin) {
  for (const frame of decoder.push(chunk)) {
    if (isTurnEvent(frame)) handle(frame);
    else logViolation(frame); // fail closed, loudly
  }
}
decoder.end();
```

### RPC envelopes

JSON-RPC 2.0 subset: `RpcRequest` (requires `id`), `RpcNotification` (no `id`),
`RpcResponse` (`result` XOR `error`; `id: null` only when unknowable), guards
(`isRpcMessage`…), constructors (`rpcRequest`…), reserved codes
(`RPC_ERROR_CODES`: -32700/-32600/-32601/-32602/-32603).

Turn events ride RPC mode as notifications on `pebble/event`
(`eventNotification` / `unwrapEvent`). An `pebble/event` notification whose
params fail validation is a protocol violation — `unwrapEvent` returns null and
callers should log loudly.

## ACP mapping table (`acp.ts`)

How Pebble renders under the Agent Client Protocol (`pebble acp`). Reference:
https://agentclientprotocol.com (session/update variants, StopReason,
PermissionOption kinds).

| pebble kind | acpMethod | session/update variant | notes |
|---|---|---|---|
| `turn.start` | — | — | Maps to the `session/prompt` REQUEST itself; no start-of-turn notification exists. |
| `turn.end` | `session/prompt` response | — | Becomes the prompt StopReason via `STOP_REASON_TO_ACP`. |
| `delta.text` | `session/update` | `agent_message_chunk` | One ContentBlock::Text per chunk. |
| `delta.thinking` | `session/update` | `agent_thought_chunk` | One ContentBlock::Text per chunk. |
| `tool.start` | `session/update` | `tool_call` | `id→toolCallId`; name+argsSummary render into title/kind (ToolKind heuristic); rawInput omitted. |
| `tool.update` | `session/update` | `tool_call_update` | delta text rides ToolCallContent blocks. |
| `tool.end` | `session/update` | `tool_call_update` | Status via `TOOL_OUTCOME_TO_ACP_STATUS`; detail rides content on failure. |
| `usage` | `session/update` | `usage_update` | `costUsd≠null → cost.amount` + currency `"USD"`; `costUsd=null` means UNKNOWN — omit cost, never send 0. Full decomposition rides `_meta.pebble.usage`. |
| `stage.open` | `session/update` | `plan` | Sliding-window narration: open adds an in_progress entry. |
| `stage.rewrite` | `session/update` | `plan` | Retitles the open plan entry in place. |
| `stage.close` | `session/update` | `plan` | Marks the entry completed. |
| `error` | — | — | No standard ACP error notification; post-retry failures surface via prompt StopReason (`error→refusal`); optionally `_meta.pebble.error`. |
| `permission.request` | — | — | Frozen legacy schema-only compatibility data; never mapped, dispatched, or interpreted. |
| `permission.resolve` | — | — | Frozen legacy schema-only compatibility data; never mapped, dispatched, or interpreted. |
| `queue.changed` | — | — | TUI-native queue state. |
| `checkpoint.created` | — | — | Optionally `_meta.pebble.checkpoint`. |
| `route.decided` | — | — | Route reason display is Pebble-native (never savings deltas); optionally `_meta.pebble.route`. |
| `budget.stopped` | — | — | Manifests as `turn.end` with `budget_paused` (→ `refusal`); amounts stay on the Pebble stream/`_meta`. |
| `session.compacting` | — | — | Renderer-side distinct compacting state; optionally an `agent_thought_chunk` notice. |

Value mappings:

| Pebble stop_reason | ACP StopReason | Why |
|---|---|---|
| `end_turn` | `end_turn` | identity |
| `awaiting_input` | `end_turn` | agent waits for the next prompt |
| `awaiting_approval` | `end_turn` | frozen legacy mapping only; no runtime approval flow |
| `budget_paused` | `refusal` | agent declines to continue spending; precise reason stays on the stream |
| `interrupted` | `cancelled` | identity |
| `error` | `refusal` | post-retry terminal failure |

| Pebble decision | ACP PermissionOption kind |
|---|---|
| `allow-once` | `allow_once` |
| `allow-session` | `allow_always` |
| `deny` | `reject_once` (nothing remembered; pebble asks again per request) |

Tool outcomes: `completed→completed`, `failed→failed`, `cancelled→null` (ACP
reserves cancellation for CLIENTS; agents emit no status update).

## Validators

Hand-rolled, zero dependencies: `isTurnEvent`, `isUsage`, `isStopReason`,
`isSessionEntry`. Strict about every documented field — types, closed enums,
literal `retryable: false`, RFC 3339 timestamps, integer counts, finite money —
and deliberately tolerant ONLY of unknown extra properties so additive-minor
producers keep older readers working.

## Versioning policy

1. **This package is FROZEN at 0.1.0.**
2. Breaking change (shape, names, types, enum membership, ordering constraints,
   semantics, removal) ⇒ **new major version**. Frozen v1 artifacts stay
   importable alongside.
3. Additive optional fields ⇒ minor version. Validators ignore unknown
   properties precisely so old readers survive new writers.
4. Every change must regenerate golden fixtures (one per event kind,
   `scripts/regenerate-fixtures.mjs`) and pass the round-trip suite:
   fixture bytes → decode → validate → re-encode → **byte equality**.
5. Proposals land through a spine/integration review before any code changes;
   downstream packages compile against released types only.
6. Bun pinned ≥1.4.0 (engines field); local bun below 1.4 degrades loudly.

## License

Apache-2.0. See LICENSE.
