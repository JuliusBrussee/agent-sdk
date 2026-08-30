# `@pebble-agent/protocol` API reference

> Generated from the built type declarations by `node scripts/generate-docs-api.mjs`.
> Do not edit by hand. Version at generation time: `0.1.0`.

PEBBLE wire and storage contract (v1, FROZEN): turn events, session entries, JSONL-RPC framing, ACP mapping. Zero runtime dependencies.

## Entrypoints

| Import specifier | Declarations | Exported symbols |
| --- | --- | --- |
| `@pebble-agent/protocol` | `packages/pebble-protocol/dist/index.d.ts` | 86 |

## `@pebble-agent/protocol`

Declaration file: `packages/pebble-protocol/dist/index.d.ts`.

<details><summary>Symbol index</summary>

- **Class**: `JsonlDecoder`, `ProtocolError`, `SessionEventSequenceCoordinator`, `TurnEventSequenceError`, `TurnEventSequenceValidator`
- **Interface**: `AcpMappingRow`, `BudgetStoppedEvent`, `CheckpointCreatedEvent`, `DeltaTextEvent`, `DeltaThinkingEvent`, `EnvelopeFields`, `ErrorEvent`, `JsonlDecoderOptions`, `PermissionRequestEvent`, `PermissionResolveEvent`, `QueueChangedEvent`, `RouteDecidedEvent`, `RpcErrorObject`, `RpcNotification`, `RpcRequest`, `RpcResponse`, `SessionCompactingEvent`, `SessionEntry`, `SessionEventSequenceCoordinatorOptions`, `SessionEventSequenceSummary`, `StageCloseEvent`, `StageOpenEvent`, `StageRewriteEvent`, `ToolEndEvent`, `ToolStartEvent`, `ToolUpdateEvent`, `TurnEndEvent`, `TurnEventSequenceSummary`, `TurnEventSequenceValidatorOptions`, `TurnStartEvent`, `Usage`, `UsageEvent`
- **Type alias**: `AcpMethod`, `AcpStopReason`, `AcpUpdateVariant`, `PermissionDecision`, `ProtocolErrorCode`, `RpcMessage`, `SessionRole`, `StopReason`, `ToolOutcome`, `TurnEvent`, `TurnEventKind`, `TurnEventSequenceErrorCode`
- **Function**: `acpRowFor`, `decodeFrames`, `encodeFrame`, `encodeFrameText`, `isRpcMessage`, `isRpcNotification`, `isRpcRequest`, `isRpcResponse`, `isSessionEntry`, `isStopReason`, `isTurnEvent`, `isUsage`, `rpcErrorResponse`, `rpcNotification`, `rpcRequest`, `rpcResponse`, `unwrapEvent`
- **Variable**: `ACP_MAPPING`, `ACP_METHODS`, `ACP_STOP_REASONS`, `ACP_UPDATE_VARIANTS`, `ALL_EVENT_KINDS`, `DEFAULT_MAX_FRAME_BYTES`, `DEFAULT_MAX_OPEN_LIFECYCLES`, `DEFAULT_MAX_RETAINED_IDENTITY_BYTES`, `DEFAULT_MAX_SEEN_LIFECYCLE_IDS`, `DEFAULT_MAX_SEEN_SESSION_TOOL_IDS`, `EVENT_NOTIFICATION_METHOD`, `PERMISSION_DECISIONS`, `PROTOCOL_VERSION`, `RPC_ERROR_CODES`, `SESSION_ROLES`, `STOP_REASON_TO_ACP`, `STOP_REASONS`, `TOOL_OUTCOME_TO_ACP_STATUS`, `TOOL_OUTCOMES`, `TURN_EVENT_SEQUENCE_ERROR_CODES`

</details>

### Classes

#### `JsonlDecoder`

Incremental byte-accurate JSONL decoder. Feed it chunks from any source
(stdin, socket, file); it returns fully parsed frames in order as soon as
their terminating newlines arrive.

```ts
export declare class JsonlDecoder {
    #private;
    constructor(options?: JsonlDecoderOptions);
    /**
     * Feed one chunk (bytes or a JS string, which is encoded as UTF-8 first).
     * Returns every frame that completed with this push, parsed, in order.
     * Throws {@link ProtocolError} on invalid JSON/UTF-8 or frame-size overrun.
     */
    push(chunk: Uint8Array | string): unknown[];
    /**
     * Signal clean end-of-stream. Fails loudly when unparsed bytes remain —
     * a truncated final frame means the peer died mid-write, not "end of input".
     */
    end(): void;
    /** Bytes currently held awaiting their terminating newline. */
    get buffered(): number;
    /**
     * Absolute byte offset of the next unparsed frame start in the stream.
     * Between pushes this equals the start of the currently buffered partial
     * frame (everything before it has been emitted or skipped).
     */
    get streamOffset(): number;
}
```

Declared in `packages/pebble-protocol/dist/framing.d.ts`.

#### `ProtocolError`

Loud failure of framing or serialization. Always carries an error code.

```ts
export declare class ProtocolError extends Error {
    readonly code: ProtocolErrorCode;
    constructor(code: ProtocolErrorCode, message: string, options?: {
        cause?: unknown;
    });
}
```

Declared in `packages/pebble-protocol/dist/framing.d.ts`.

#### `SessionEventSequenceCoordinator`

Coordinates complete turns into one bounded frozen-v1 session stream.

Exactly one TurnEventSequenceValidator is live at a time. Completed turn
validators are discarded after their frozen summary is folded into bounded
aggregate evidence. Only tool-call ids remain retained across turns because
the frozen event contract requires those ids to be unique per session.

Legacy permission events remain opaque schema-valid events. They create no
coordinator state and repeated permission ids have no lifecycle semantics.

```ts
export declare class SessionEventSequenceCoordinator {
    #private;
    constructor(options?: SessionEventSequenceCoordinatorOptions);
    /** Next contiguous sequence number required by push(). */
    get nextSeq(): number;
    /** Locked session identity, or undefined before first accepted event. */
    get sessionId(): string | undefined;
    /** Number of completed turns folded into aggregate evidence. */
    get turnCount(): number;
    /** Number of session-wide tool-call identities retained. */
    get seenToolCallIdCount(): number;
    /** Most recently completed immutable turn summary. */
    get latestTurnSummary(): TurnEventSequenceSummary | undefined;
    /** True only after finish()/end() accepted one or more complete turns. */
    get finished(): boolean;
    /**
     * Validate one event and return a detached, frozen snapshot. Any turn or
     * session failure poisons the coordinator so callers cannot silently resync.
     */
    push(value: unknown): TurnEvent;
    /** Close input and return immutable bounded evidence for the session. */
    finish(): SessionEventSequenceSummary;
    /** Alias for stream APIs that signal completion with end(). */
    end(): SessionEventSequenceSummary;
}
```

Declared in `packages/pebble-protocol/dist/sequence.d.ts`.

#### `TurnEventSequenceError`

Machine-readable protocol-sequence failure. A failed validator stays failed.

```ts
export declare class TurnEventSequenceError extends Error {
    readonly code: TurnEventSequenceErrorCode;
    readonly eventKind: string | null;
    readonly seq: number | null;
    constructor(code: TurnEventSequenceErrorCode, message: string, event?: Readonly<{
        kind: string;
        seq: number;
    }> | undefined);
}
```

Declared in `packages/pebble-protocol/dist/sequence.d.ts`.

#### `TurnEventSequenceValidator`

Incremental, zero-dependency validator for one frozen-v1 turn stream.

Legacy `permission.request/resolve` shapes are checked by `isTurnEvent` and
otherwise remain opaque. This validator adds no permission state machine.

```ts
export declare class TurnEventSequenceValidator {
    #private;
    constructor(options?: TurnEventSequenceValidatorOptions);
    /** Next contiguous sequence number required by push(). */
    get nextSeq(): number;
    /** Locked session identity, or undefined before first event without an option. */
    get sessionId(): string | undefined;
    /** Number of currently open structural lifecycles. */
    get openLifecycleCount(): number;
    /** Number of distinct structural lifecycle ids retained for this turn. */
    get seenLifecycleIdCount(): number;
    /** True only after finish()/end() accepted a complete terminal turn. */
    get finished(): boolean;
    /**
     * Validate and accept one event. Returns a detached, frozen schema-narrowed
     * snapshot; caller mutation cannot rewrite accepted sequence evidence.
     * Any failure poisons this validator so callers cannot silently resync.
     */
    push(value: unknown): TurnEvent;
    /** Close input and return immutable evidence for one complete turn. */
    finish(): TurnEventSequenceSummary;
    /** Alias for stream APIs that signal completion with end(). */
    end(): TurnEventSequenceSummary;
}
```

Declared in `packages/pebble-protocol/dist/sequence.d.ts`.

### Interfaces

#### `AcpMappingRow`

One row of the frozen pebble→ACP mapping.

```ts
export interface AcpMappingRow {
    readonly pebbleKind: TurnEventKind;
    /** ACP method carrying the event, or null when no first-class surface exists. */
    readonly acpMethod: AcpMethod | string | null;
    /** session/update variant discriminator when acpMethod is session/update. */
    readonly acpUpdate: AcpUpdateVariant | null;
    readonly notes: string;
}
```

Declared in `packages/pebble-protocol/dist/acp.d.ts`.

#### `BudgetStoppedEvent`

Budget ceiling hit; the run stopped instead of spending past the cap.

```ts
export interface BudgetStoppedEvent extends EnvelopeFields {
    kind: "budget.stopped";
    estimateUsd: number;
    leftUsd: number;
    message: string;
}
```

Declared in `packages/pebble-protocol/dist/events.d.ts`.

#### `CheckpointCreatedEvent`

A checkpoint landed; `ref` is opaque, `n` is the running count within the session.

```ts
export interface CheckpointCreatedEvent extends EnvelopeFields {
    kind: "checkpoint.created";
    ref: string;
    n: number;
}
```

Declared in `packages/pebble-protocol/dist/events.d.ts`.

#### `DeltaTextEvent`

Streaming assistant text delta. Concatenated by consumers, never rewritten.

```ts
export interface DeltaTextEvent extends EnvelopeFields {
    kind: "delta.text";
    text: string;
}
```

Declared in `packages/pebble-protocol/dist/events.d.ts`.

#### `DeltaThinkingEvent`

Streaming assistant reasoning/thinking delta (rendered distinctly from text).

```ts
export interface DeltaThinkingEvent extends EnvelopeFields {
    kind: "delta.thinking";
    text: string;
}
```

Declared in `packages/pebble-protocol/dist/events.d.ts`.

#### `EnvelopeFields`

Fields present on every event. See PROTOCOL_VERSION for `v`.

```ts
export interface EnvelopeFields {
    /** Protocol version. Always `1` inside this major line. */
    v: 1;
    /**
     * Producer-assigned sequence number: monotonically increasing, gap-free per
     * session stream, starting at 0. Validators do NOT enforce continuity —
     * transports may reorder or duplicate — but consumers SHOULD detect gaps
     * and surface them rather than silently resyncing.
     */
    seq: number;
    /** Producer wall-clock time at emission, RFC 3339 / ISO 8601 (UTC recommended). */
    ts: string;
    /** Session the event belongs to. */
    sessionId: string;
}
```

Declared in `packages/pebble-protocol/dist/events.d.ts`.

#### `ErrorEvent`

Terminal error surfaced AFTER retries have settled — one transient 429 must
never paint N red blocks downstream. Producers MUST only emit this once they
have exhausted their retry budget; `retryable` is always exactly `false`.

```ts
export interface ErrorEvent extends EnvelopeFields {
    kind: "error";
    message: string;
    retryable: false;
}
```

Declared in `packages/pebble-protocol/dist/events.d.ts`.

#### `JsonlDecoderOptions`

```ts
export interface JsonlDecoderOptions {
    /** Maximum buffered size of one incomplete frame. Default 16 MiB. */
    maxFrameBytes?: number | undefined;
}
```

Declared in `packages/pebble-protocol/dist/framing.d.ts`.

#### `PermissionRequestEvent`

Permission needed to run something. Resolved by exactly one permission.resolve.

```ts
export interface PermissionRequestEvent extends EnvelopeFields {
    kind: "permission.request";
    id: string;
    /** Tool or capability name being gated, e.g. "bash". */
    tool: string;
    /** Plain-language copy shown inline; technical detail stays collapsed behind it. */
    plainLanguage: string;
    /** Optional technical detail (raw command, path, diff scope). */
    detail?: string | undefined;
}
```

Declared in `packages/pebble-protocol/dist/events.d.ts`.

#### `PermissionResolveEvent`

Resolution of a prior permission.request with the same id.

```ts
export interface PermissionResolveEvent extends EnvelopeFields {
    kind: "permission.resolve";
    id: string;
    decision: PermissionDecision;
}
```

Declared in `packages/pebble-protocol/dist/events.d.ts`.

#### `QueueChangedEvent`

Kernel-owned queue state changed (typing-while-streaming, steering, interrupt-pause).

```ts
export interface QueueChangedEvent extends EnvelopeFields {
    kind: "queue.changed";
    queued: number;
    /** True when entries are held because an interrupt paused the loop. */
    heldAfterInterrupt: boolean;
}
```

Declared in `packages/pebble-protocol/dist/events.d.ts`.

#### `RouteDecidedEvent`

Structural routing decided which model serves this segment. Surfaces show
route REASONS — never savings deltas; savings remain inferred until a
holdout measures them, and this event never claims otherwise.

```ts
export interface RouteDecidedEvent extends EnvelopeFields {
    kind: "route.decided";
    model: string;
    reason: string;
    signals: string[];
}
```

Declared in `packages/pebble-protocol/dist/events.d.ts`.

#### `RpcErrorObject`

```ts
export interface RpcErrorObject {
    code: number;
    message: string;
    data?: unknown;
}
```

Declared in `packages/pebble-protocol/dist/framing.d.ts`.

#### `RpcNotification`

```ts
export interface RpcNotification {
    jsonrpc: "2.0";
    method: string;
    params?: unknown;
}
```

Declared in `packages/pebble-protocol/dist/framing.d.ts`.

#### `RpcRequest`

```ts
export interface RpcRequest {
    jsonrpc: "2.0";
    id: number | string;
    method: string;
    params?: unknown;
}
```

Declared in `packages/pebble-protocol/dist/framing.d.ts`.

#### `RpcResponse`

```ts
export interface RpcResponse {
    jsonrpc: "2.0";
    /** null only when the request id could not be determined (JSON-RPC spec). */
    id: number | string | null;
    result?: unknown;
    error?: RpcErrorObject;
}
```

Declared in `packages/pebble-protocol/dist/framing.d.ts`.

#### `SessionCompactingEvent`

Compaction started/completed for this session. When present,
firstKeptEntryId points at the oldest surviving original entry — everything
before it is represented by a summary entry (role "summary") written to
session storage.

```ts
export interface SessionCompactingEvent extends EnvelopeFields {
    kind: "session.compacting";
    firstKeptEntryId?: string | undefined;
}
```

Declared in `packages/pebble-protocol/dist/events.d.ts`.

#### `SessionEntry`

One persisted conversation node.

```ts
export interface SessionEntry {
    /** Entry id, unique within the session store. */
    id: string;
    /** Parent entry id, or null for the tree root. */
    parentId: string | null;
    role: SessionRole;
    /** Full text content of the entry (deltas already concatenated). */
    content: string;
    /** Token/cost accounting when the entry was produced by model calls. */
    usage?: Usage;
    /** RFC 3339 timestamp of creation. */
    ts: string;
    /** Schema version. Always 1 inside this major line; drives migrating loaders. */
    v: 1;
}
```

Declared in `packages/pebble-protocol/dist/session.d.ts`.

#### `SessionEventSequenceCoordinatorOptions`

Bounds for one complete session stream beginning at sequence zero.

```ts
export interface SessionEventSequenceCoordinatorOptions {
    /** Optional expected session identity. Otherwise first valid event locks it. */
    sessionId?: string | undefined;
    /** Maximum concurrently open structural lifecycles in one turn. */
    maxOpenLifecycles?: number | undefined;
    /** Maximum distinct lifecycle ids retained by one turn validator. */
    maxSeenLifecycleIds?: number | undefined;
    /** Maximum tool-call ids retained across the session. */
    maxSeenToolCallIds?: number | undefined;
    /** Maximum UTF-8 bytes retained for session and tool-call identities. */
    maxRetainedIdentityBytes?: number | undefined;
}
```

Declared in `packages/pebble-protocol/dist/sequence.d.ts`.

#### `SessionEventSequenceSummary`

Bounded aggregate evidence returned after a complete session stream.

```ts
export interface SessionEventSequenceSummary {
    readonly sessionId: string;
    readonly firstSeq: 0;
    readonly lastSeq: number;
    readonly eventCount: number;
    readonly turnCount: number;
    readonly toolCallCount: number;
    readonly peakOpenLifecycles: number;
}
```

Declared in `packages/pebble-protocol/dist/sequence.d.ts`.

#### `StageCloseEvent`

A narration stage closes (completed, not failed).

```ts
export interface StageCloseEvent extends EnvelopeFields {
    kind: "stage.close";
    id: string;
}
```

Declared in `packages/pebble-protocol/dist/events.d.ts`.

#### `StageOpenEvent`

A narration stage opens. Sliding-window stage narration, 2–5 stages per turn.

```ts
export interface StageOpenEvent extends EnvelopeFields {
    kind: "stage.open";
    id: string;
    label: string;
}
```

Declared in `packages/pebble-protocol/dist/events.d.ts`.

#### `StageRewriteEvent`

The previously open stage is retitled before/while the next opens — part of
the sliding-window contract (`summary` closes+rewrites the prior stage).

```ts
export interface StageRewriteEvent extends EnvelopeFields {
    kind: "stage.rewrite";
    id: string;
    label: string;
}
```

Declared in `packages/pebble-protocol/dist/events.d.ts`.

#### `ToolEndEvent`

Tool invocation finished. Failed tools stay folded in UIs; detail carries why.

```ts
export interface ToolEndEvent extends EnvelopeFields {
    kind: "tool.end";
    id: string;
    status: ToolOutcome;
    /** Optional human-readable closing detail (e.g. failure message). */
    detail?: string | undefined;
}
```

Declared in `packages/pebble-protocol/dist/events.d.ts`.

#### `ToolStartEvent`

Tool invocation begins. `id` is unique within the session.

```ts
export interface ToolStartEvent extends EnvelopeFields {
    kind: "tool.start";
    id: string;
    name: string;
    /** Human-readable summary of the args for row rendering. May be empty. */
    argsSummary: string;
}
```

Declared in `packages/pebble-protocol/dist/events.d.ts`.

#### `ToolUpdateEvent`

Progress update on a running tool. `delta` semantics are producer-defined text.

```ts
export interface ToolUpdateEvent extends EnvelopeFields {
    kind: "tool.update";
    id: string;
    delta: string;
}
```

Declared in `packages/pebble-protocol/dist/events.d.ts`.

#### `TurnEndEvent`

Turn lifecycle ends. Carries the authoritative StopReason.

```ts
export interface TurnEndEvent extends EnvelopeFields {
    kind: "turn.end";
    stopReason: StopReason;
}
```

Declared in `packages/pebble-protocol/dist/events.d.ts`.

#### `TurnEventSequenceSummary`

Evidence returned only after one complete, valid turn.

```ts
export interface TurnEventSequenceSummary {
    readonly sessionId: string;
    readonly firstSeq: number;
    readonly lastSeq: number;
    readonly eventCount: number;
    readonly stopReason: StopReason;
    readonly errorEventSeen: boolean;
    readonly peakOpenLifecycles: number;
}
```

Declared in `packages/pebble-protocol/dist/sequence.d.ts`.

#### `TurnEventSequenceValidatorOptions`

One validator represents exactly one turn on one session stream.
`firstSeq` lets callers validate a later turn in a session-wide sequence.
Use SessionEventSequenceCoordinator when validating a complete session and
enforcing tool-id uniqueness across turns.

```ts
export interface TurnEventSequenceValidatorOptions {
    /** Required sequence number for turn.start. Defaults to session-stream origin 0. */
    firstSeq?: number | undefined;
    /** Optional expected session identity. Otherwise first valid event locks it. */
    sessionId?: string | undefined;
    /** Maximum concurrently open structural lifecycles. Defaults to 1,024. */
    maxOpenLifecycles?: number | undefined;
    /** Maximum distinct lifecycle ids retained for this turn. Defaults to 4,096. */
    maxSeenLifecycleIds?: number | undefined;
    /** Maximum UTF-8 bytes retained for session/lifecycle ids. Defaults to 1 MiB. */
    maxRetainedIdentityBytes?: number | undefined;
}
```

Declared in `packages/pebble-protocol/dist/sequence.d.ts`.

#### `TurnStartEvent`

Turn lifecycle begins. Exactly one per producer turn.

```ts
export interface TurnStartEvent extends EnvelopeFields {
    kind: "turn.start";
}
```

Declared in `packages/pebble-protocol/dist/events.d.ts`.

#### `Usage`

Token accounting for one model call or an aggregate over a turn segment.

```ts
export interface Usage {
    /** Input tokens billed at the non-cached rate. */
    in: number;
    /** Output tokens (including reasoning tokens when the provider folds them). */
    out: number;
    /** Tokens served from the provider-side prompt cache. */
    cacheRead: number;
    /** Tokens written into the provider-side prompt cache. */
    cacheWrite: number;
    /**
     * Measured cost in US dollars, or `null` when no public-catalog price exists
     * for the model call(s) behind this usage. `null` means "unknown", never
     * "$0 spent": consumers MUST render it as unknown rather than treating it
     * as zero. Inferred-savings surfaces never derive from this number.
     */
    costUsd: number | null;
    /** Model id the usage belongs to, e.g. "claude-opus-4-6". Unknown model ids stay verbatim. */
    model: string;
}
```

Declared in `packages/pebble-protocol/dist/events.d.ts`.

#### `UsageEvent`

Per-call (or aggregated) token/cost accounting. Emitted after the calls it
describes settle. Cost honesty rules live on {@link Usage}.

```ts
export interface UsageEvent extends EnvelopeFields {
    kind: "usage";
    usage: Usage;
}
```

Declared in `packages/pebble-protocol/dist/events.d.ts`.

### Type aliases

#### `AcpMethod`

```ts
export type AcpMethod = (typeof ACP_METHODS)[number];
```

Declared in `packages/pebble-protocol/dist/acp.d.ts`.

#### `AcpStopReason`

```ts
export type AcpStopReason = (typeof ACP_STOP_REASONS)[number];
```

Declared in `packages/pebble-protocol/dist/acp.d.ts`.

#### `AcpUpdateVariant`

```ts
export type AcpUpdateVariant = (typeof ACP_UPDATE_VARIANTS)[number];
```

Declared in `packages/pebble-protocol/dist/acp.d.ts`.

#### `PermissionDecision`

User decision resolving a `permission.request`.

```ts
export type PermissionDecision = "allow-once" | "allow-session" | "deny";
```

Declared in `packages/pebble-protocol/dist/events.d.ts`.

#### `ProtocolErrorCode`

```ts
export type ProtocolErrorCode = "bad-json" | "bad-utf8" | "frame-too-large" | "trailing-bytes";
```

Declared in `packages/pebble-protocol/dist/framing.d.ts`.

#### `RpcMessage`

```ts
export type RpcMessage = RpcRequest | RpcNotification | RpcResponse;
```

Declared in `packages/pebble-protocol/dist/framing.d.ts`.

#### `SessionRole`

Who authored the entry. "summary" marks compaction-written synthetic entries.

```ts
export type SessionRole = "user" | "assistant" | "system" | "summary";
```

Declared in `packages/pebble-protocol/dist/session.d.ts`.

#### `StopReason`

Why a turn stopped. This enum is EXACTLY these six values and nothing else;
producers must not invent synonyms and consumers must treat unknown values
as protocol violations (fail closed).

```ts
export type StopReason = "end_turn" | "awaiting_input" | "awaiting_approval" | "budget_paused" | "interrupted" | "error";
```

Declared in `packages/pebble-protocol/dist/events.d.ts`.

#### `ToolOutcome`

Outcome of a tool invocation reported by `tool.end`.

```ts
export type ToolOutcome = "completed" | "failed" | "cancelled";
```

Declared in `packages/pebble-protocol/dist/events.d.ts`.

#### `TurnEvent`

The full turn-event union. Discriminate on `kind`.

```ts
export type TurnEvent = TurnStartEvent | TurnEndEvent | DeltaTextEvent | DeltaThinkingEvent | ToolStartEvent | ToolUpdateEvent | ToolEndEvent | UsageEvent | StageOpenEvent | StageRewriteEvent | StageCloseEvent | ErrorEvent | PermissionRequestEvent | PermissionResolveEvent | QueueChangedEvent | CheckpointCreatedEvent | RouteDecidedEvent | BudgetStoppedEvent | SessionCompactingEvent;
```

Declared in `packages/pebble-protocol/dist/events.d.ts`.

#### `TurnEventKind`

```ts
export type TurnEventKind = (typeof ALL_EVENT_KINDS)[number];
```

Declared in `packages/pebble-protocol/dist/events.d.ts`.

#### `TurnEventSequenceErrorCode`

```ts
export type TurnEventSequenceErrorCode = (typeof TURN_EVENT_SEQUENCE_ERROR_CODES)[number];
```

Declared in `packages/pebble-protocol/dist/sequence.d.ts`.

### Functions

#### `acpRowFor`

Look up the frozen ACP mapping row for an event kind. Total over all kinds.

```ts
export declare function acpRowFor(kind: TurnEventKind): AcpMappingRow;
```

Declared in `packages/pebble-protocol/dist/acp.d.ts`.

#### `decodeFrames`

One-shot decode: parse all complete frames in a buffer, then verify clean EOF.

```ts
export declare function decodeFrames(bytes: Uint8Array, options?: JsonlDecoderOptions): unknown[];
```

Declared in `packages/pebble-protocol/dist/framing.d.ts`.

#### `encodeFrame`

Serialize one value to UTF-8 frame bytes ready for the wire.

```ts
export declare function encodeFrame(value: unknown): Uint8Array;
```

Declared in `packages/pebble-protocol/dist/framing.d.ts`.

#### `encodeFrameText`

Serialize one value as a canonical JSONL frame string ("{...}\n").

```ts
export declare function encodeFrameText(value: unknown): string;
```

Declared in `packages/pebble-protocol/dist/framing.d.ts`.

#### `isRpcMessage`

```ts
export declare function isRpcMessage(value: unknown): value is RpcMessage;
```

Declared in `packages/pebble-protocol/dist/framing.d.ts`.

#### `isRpcNotification`

```ts
export declare function isRpcNotification(value: unknown): value is RpcNotification;
```

Declared in `packages/pebble-protocol/dist/framing.d.ts`.

#### `isRpcRequest`

```ts
export declare function isRpcRequest(value: unknown): value is RpcRequest;
```

Declared in `packages/pebble-protocol/dist/framing.d.ts`.

#### `isRpcResponse`

```ts
export declare function isRpcResponse(value: unknown): value is RpcResponse;
```

Declared in `packages/pebble-protocol/dist/framing.d.ts`.

#### `isSessionEntry`

Validate one parsed JSONL line against the frozen v1 session-entry schema.
Strict about documented fields; tolerant ONLY of unknown extra properties
(additive-minor evolution — see README versioning policy).

```ts
export declare function isSessionEntry(value: unknown): value is SessionEntry;
```

Declared in `packages/pebble-protocol/dist/session.d.ts`.

#### `isStopReason`

Narrow to a StopReason. Exact six-value membership; anything else is rejected.

```ts
export declare function isStopReason(value: unknown): value is StopReason;
```

Declared in `packages/pebble-protocol/dist/events.d.ts`.

#### `isTurnEvent`

Validate one decoded frame against the frozen v1 event schema. Strict about
every documented field (types, enums, literals); tolerant ONLY of unknown
extra properties, so additive-minor producers keep older readers working.

```ts
export declare function isTurnEvent(value: unknown): value is TurnEvent;
```

Declared in `packages/pebble-protocol/dist/events.d.ts`.

#### `isUsage`

Narrow token/cost accounting. Rejects NaN, infinities, negative or fractional counts.

```ts
export declare function isUsage(value: unknown): value is Usage;
```

Declared in `packages/pebble-protocol/dist/events.d.ts`.

#### `rpcErrorResponse`

```ts
export declare function rpcErrorResponse(id: number | string | null, code: number, message: string, data?: unknown): RpcResponse;
```

Declared in `packages/pebble-protocol/dist/framing.d.ts`.

#### `rpcNotification`

```ts
export declare function rpcNotification(method: string, params?: unknown): RpcNotification;
```

Declared in `packages/pebble-protocol/dist/framing.d.ts`.

#### `rpcRequest`

```ts
export declare function rpcRequest(id: number | string, method: string, params?: unknown): RpcRequest;
```

Declared in `packages/pebble-protocol/dist/framing.d.ts`.

#### `rpcResponse`

```ts
export declare function rpcResponse(id: number | string, result: unknown): RpcResponse;
```

Declared in `packages/pebble-protocol/dist/framing.d.ts`.

#### `unwrapEvent`

Extract a turn event from a decoded RPC message. Returns the validated
event, or null when the message isn't an pebble/event notification or its
params fail validation (protocol violation — callers should log loudly).

```ts
export declare function unwrapEvent(message: unknown): TurnEvent | null;
```

Declared in `packages/pebble-protocol/dist/framing.d.ts`.

### Variables & constants

#### `ACP_MAPPING`

THE table: every pebble event kind → its ACP rendering. Exhaustive over
ALL_EVENT_KINDS (enforced by the satisfies clause AND tests/acp.test.ts).

```ts
export declare const ACP_MAPPING: {
    readonly "turn.start": {
        readonly pebbleKind: "turn.start";
        readonly acpMethod: null;
        readonly acpUpdate: null;
        readonly notes: "Maps to the session/prompt REQUEST itself; ACP has no start-of-turn notification.";
    };
    readonly "turn.end": {
        readonly pebbleKind: "turn.end";
        readonly acpMethod: "session/prompt";
        readonly acpUpdate: null;
        readonly notes: "Becomes the prompt RESPONSE stop reason via STOP_REASON_TO_ACP.";
    };
    readonly "delta.text": {
        readonly pebbleKind: "delta.text";
        readonly acpMethod: "session/update";
        readonly acpUpdate: "agent_message_chunk";
        readonly notes: "text rides one ContentBlock::Text per chunk.";
    };
    readonly "delta.thinking": {
        readonly pebbleKind: "delta.thinking";
        readonly acpMethod: "session/update";
        readonly acpUpdate: "agent_thought_chunk";
        readonly notes: "text rides one ContentBlock::Text per chunk.";
    };
    readonly "tool.start": {
        readonly pebbleKind: "tool.start";
        readonly acpMethod: "session/update";
        readonly acpUpdate: "tool_call";
        readonly notes: "id→toolCallId; name+argsSummary render into title/kind (kind via ToolKind heuristic); rawInput omitted.";
    };
    readonly "tool.update": {
        readonly pebbleKind: "tool.update";
        readonly acpMethod: "session/update";
        readonly acpUpdate: "tool_call_update";
        readonly notes: "delta text rides ToolCallContent::Content blocks.";
    };
    readonly "tool.end": {
        readonly pebbleKind: "tool.end";
        readonly acpMethod: "session/update";
        readonly acpUpdate: "tool_call_update";
        readonly notes: "status via TOOL_OUTCOME_TO_ACP_STATUS; detail rides content on failure.";
    };
    readonly usage: {
        readonly pebbleKind: "usage";
        readonly acpMethod: "session/update";
        readonly acpUpdate: "usage_update";
        readonly notes: "costUsd≠null → cost.amount + currency 'USD'; costUsd=null means UNKNOWN — omit cost, never send 0. Full per-class decomposition rides _meta.pebble.usage.";
    };
    readonly "stage.open": {
        readonly pebbleKind: "stage.open";
        readonly acpMethod: "session/update";
        readonly acpUpdate: "plan";
        readonly notes: "Sliding-window narration renders as plan entries: open adds an in_progress entry.";
    };
    readonly "stage.rewrite": {
        readonly pebbleKind: "stage.rewrite";
        readonly acpMethod: "session/update";
        readonly acpUpdate: "plan";
        readonly notes: "Retitles the open plan entry in place.";
    };
    readonly "stage.close": {
        readonly pebbleKind: "stage.close";
        readonly acpMethod: "session/update";
        readonly acpUpdate: "plan";
        readonly notes: "Marks the entry completed.";
    };
    readonly error: {
        readonly pebbleKind: "error";
        readonly acpMethod: null;
        readonly acpUpdate: null;
        readonly notes: "No standard ACP error notification; post-retry failures surface via the prompt response stop reason (error→refusal). Optionally attached as _meta.pebble.error.";
    };
    readonly "permission.request": {
        readonly pebbleKind: "permission.request";
        readonly acpMethod: null;
        readonly acpUpdate: null;
        readonly notes: "Legacy schema-only compatibility data; never mapped, dispatched, or interpreted.";
    };
    readonly "permission.resolve": {
        readonly pebbleKind: "permission.resolve";
        readonly acpMethod: null;
        readonly acpUpdate: null;
        readonly notes: "Legacy schema-only compatibility data; never mapped, dispatched, or interpreted.";
    };
    readonly "queue.changed": {
        readonly pebbleKind: "queue.changed";
        readonly acpMethod: null;
        readonly acpUpdate: null;
        readonly notes: "TUI-native queue state; no ACP surface.";
    };
    readonly "checkpoint.created": {
        readonly pebbleKind: "checkpoint.created";
        readonly acpMethod: null;
        readonly acpUpdate: null;
        readonly notes: "Pebble-native checkpoint ledger; optionally _meta.pebble.checkpoint.";
    };
    readonly "route.decided": {
        readonly pebbleKind: "route.decided";
        readonly acpMethod: null;
        readonly acpUpdate: null;
        readonly notes: "Route REASON display is pebble-native (never savings deltas); optionally _meta.pebble.route.";
    };
    readonly "budget.stopped": {
        readonly pebbleKind: "budget.stopped";
        readonly acpMethod: null;
        readonly acpUpdate: null;
        readonly notes: "Manifests to ACP as turn.end with stopReason budget_paused (→ refusal); amounts stay on the pebble stream/_meta.";
    };
    readonly "session.compacting": {
        readonly pebbleKind: "session.compacting";
        readonly acpMethod: null;
        readonly acpUpdate: null;
        readonly notes: "Renderer-side distinct compacting state; optionally surfaced as an agent_thought_chunk notice.";
    };
};
```

Declared in `packages/pebble-protocol/dist/acp.d.ts`.

#### `ACP_METHODS`

ACP methods referenced by this mapping.

```ts
export declare const ACP_METHODS: readonly ["session/prompt", "session/update"];
```

Declared in `packages/pebble-protocol/dist/acp.d.ts`.

#### `ACP_STOP_REASONS`

StopReason values an ACP agent may return from session/prompt.

```ts
export declare const ACP_STOP_REASONS: readonly ["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"];
```

Declared in `packages/pebble-protocol/dist/acp.d.ts`.

#### `ACP_UPDATE_VARIANTS`

session/update variant discriminators referenced by the mapping table.

```ts
export declare const ACP_UPDATE_VARIANTS: readonly ["user_message_chunk", "agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update", "plan", "available_commands_update", "current_mode_update", "usage_update"];
```

Declared in `packages/pebble-protocol/dist/acp.d.ts`.

#### `ALL_EVENT_KINDS`

Every event kind, fixed order. Golden fixtures under fixtures/ mirror this 1:1.

```ts
export declare const ALL_EVENT_KINDS: readonly ["turn.start", "turn.end", "delta.text", "delta.thinking", "tool.start", "tool.update", "tool.end", "usage", "stage.open", "stage.rewrite", "stage.close", "error", "permission.request", "permission.resolve", "queue.changed", "checkpoint.created", "route.decided", "budget.stopped", "session.compacting"];
```

Declared in `packages/pebble-protocol/dist/events.d.ts`.

#### `DEFAULT_MAX_FRAME_BYTES`

Default cap for one frame's byte size (16 MiB).

```ts
export declare const DEFAULT_MAX_FRAME_BYTES: number;
```

Declared in `packages/pebble-protocol/dist/framing.d.ts`.

#### `DEFAULT_MAX_OPEN_LIFECYCLES`

Default cap on concurrently open stage/tool lifecycles.

```ts
export declare const DEFAULT_MAX_OPEN_LIFECYCLES = 1024;
```

Declared in `packages/pebble-protocol/dist/sequence.d.ts`.

#### `DEFAULT_MAX_RETAINED_IDENTITY_BYTES`

Default cap on UTF-8 bytes retained for session/lifecycle identity.

```ts
export declare const DEFAULT_MAX_RETAINED_IDENTITY_BYTES = 1048576;
```

Declared in `packages/pebble-protocol/dist/sequence.d.ts`.

#### `DEFAULT_MAX_SEEN_LIFECYCLE_IDS`

Default cap on distinct lifecycle ids retained for one validated turn.

```ts
export declare const DEFAULT_MAX_SEEN_LIFECYCLE_IDS = 4096;
```

Declared in `packages/pebble-protocol/dist/sequence.d.ts`.

#### `DEFAULT_MAX_SEEN_SESSION_TOOL_IDS`

Default cap on tool-call identities retained across one session stream.

```ts
export declare const DEFAULT_MAX_SEEN_SESSION_TOOL_IDS = 65536;
```

Declared in `packages/pebble-protocol/dist/sequence.d.ts`.

#### `EVENT_NOTIFICATION_METHOD`

Method name carrying turn events in RPC mode: each event rides one
notification whose `params` IS the event object.

```ts
export declare const EVENT_NOTIFICATION_METHOD = "pebble/event";
```

Declared in `packages/pebble-protocol/dist/framing.d.ts`.

#### `PERMISSION_DECISIONS`

```ts
export declare const PERMISSION_DECISIONS: readonly ["allow-once", "allow-session", "deny"];
```

Declared in `packages/pebble-protocol/dist/events.d.ts`.

#### `PROTOCOL_VERSION`

Protocol version carried in every envelope's `v` field.

```ts
export declare const PROTOCOL_VERSION = 1;
```

Declared in `packages/pebble-protocol/dist/events.d.ts`.

#### `RPC_ERROR_CODES`

Reserved JSON-RPC error codes used by Pebble RPC mode.

```ts
export declare const RPC_ERROR_CODES: {
    readonly PARSE_ERROR: -32700;
    readonly INVALID_REQUEST: -32600;
    readonly METHOD_NOT_FOUND: -32601;
    readonly INVALID_PARAMS: -32602;
    readonly INTERNAL_ERROR: -32603;
};
```

Declared in `packages/pebble-protocol/dist/framing.d.ts`.

#### `SESSION_ROLES`

```ts
export declare const SESSION_ROLES: readonly ["user", "assistant", "system", "summary"];
```

Declared in `packages/pebble-protocol/dist/session.d.ts`.

#### `STOP_REASON_TO_ACP`

Pebble stop_reason → ACP StopReason returned from session/prompt.

awaiting_input / legacy awaiting_approval both map to a clean end of turn.
budget_paused and error map to "refusal" — the agent declines to continue —
with the precise reason carried on the event stream / _meta, because ACP has
no budget- or error-specific stop reason.

```ts
export declare const STOP_REASON_TO_ACP: Readonly<Record<StopReason, AcpStopReason>>;
```

Declared in `packages/pebble-protocol/dist/acp.d.ts`.

#### `STOP_REASONS`

```ts
export declare const STOP_REASONS: readonly ["end_turn", "awaiting_input", "awaiting_approval", "budget_paused", "interrupted", "error"];
```

Declared in `packages/pebble-protocol/dist/events.d.ts`.

#### `TOOL_OUTCOME_TO_ACP_STATUS`

Pebble tool.end outcome → ACP tool status. `null` means the AGENT emits no
status update at all: ACP reserves cancellation for CLIENTS (they mark
non-finished calls cancelled themselves upon session/cancel), so an
agent-side "cancelled" outcome surfaces as silence plus turn teardown.

```ts
export declare const TOOL_OUTCOME_TO_ACP_STATUS: Readonly<Record<ToolOutcome, "pending" | "in_progress" | "completed" | "failed" | null>>;
```

Declared in `packages/pebble-protocol/dist/acp.d.ts`.

#### `TOOL_OUTCOMES`

```ts
export declare const TOOL_OUTCOMES: readonly ["completed", "failed", "cancelled"];
```

Declared in `packages/pebble-protocol/dist/events.d.ts`.

#### `TURN_EVENT_SEQUENCE_ERROR_CODES`

```ts
export declare const TURN_EVENT_SEQUENCE_ERROR_CODES: readonly ["pebble_sequence_invalid_options", "pebble_sequence_invalid_event", "pebble_sequence_session_mismatch", "pebble_sequence_number_mismatch", "pebble_sequence_turn_start_required", "pebble_sequence_turn_start_duplicate", "pebble_sequence_lifecycle_duplicate", "pebble_sequence_lifecycle_not_open", "pebble_sequence_open_limit", "pebble_sequence_seen_limit", "pebble_sequence_identity_bytes_limit", "pebble_sequence_error_order", "pebble_sequence_terminal_mismatch", "pebble_sequence_terminal_duplicate", "pebble_sequence_event_after_terminal", "pebble_sequence_dangling_lifecycles", "pebble_sequence_terminal_missing", "pebble_sequence_stream_finished"];
```

Declared in `packages/pebble-protocol/dist/sequence.d.ts`.

