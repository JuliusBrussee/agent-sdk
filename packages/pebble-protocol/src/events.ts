/**
 * PEBBLE turn events — VERSION 1, FROZEN.
 *
 * Every event is one flat JSON object: envelope fields plus a `kind`
 * discriminator plus that kind's payload fields. Events ride stdio as single
 * JSONL frames (see framing.ts) and are persisted as session entries (see
 * session.ts).
 *
 * FROZEN: this contract was frozen at @pebble-agent/protocol 0.1.0. Any change
 * to field names, field types, the stop-reason enum, the decision vocabulary,
 * or the meaning of any event is BREAKING and requires a new major version
 * (see README "Versioning policy"). Additive optional fields may ship in a
 * minor version; validators deliberately tolerate unknown extra properties so
 * older readers survive additive-minor producers.
 */

/** Protocol version carried in every envelope's `v` field. */
export const PROTOCOL_VERSION = 1;

/**
 * Why a turn stopped. This enum is EXACTLY these six values and nothing else;
 * producers must not invent synonyms and consumers must treat unknown values
 * as protocol violations (fail closed).
 */
export type StopReason =
  | "end_turn"
  | "awaiting_input"
  | "awaiting_approval"
  | "budget_paused"
  | "interrupted"
  | "error";

export const STOP_REASONS = [
  "end_turn",
  "awaiting_input",
  "awaiting_approval",
  "budget_paused",
  "interrupted",
  "error",
] as const;

/** Outcome of a tool invocation reported by `tool.end`. */
export type ToolOutcome = "completed" | "failed" | "cancelled";

export const TOOL_OUTCOMES = ["completed", "failed", "cancelled"] as const;

/** User decision resolving a `permission.request`. */
export type PermissionDecision = "allow-once" | "allow-session" | "deny";

export const PERMISSION_DECISIONS = [
  "allow-once",
  "allow-session",
  "deny",
] as const;

/** Token accounting for one model call or an aggregate over a turn segment. */
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

/** Fields present on every event. See PROTOCOL_VERSION for `v`. */
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

// ---------------------------------------------------------------------------
// Event interfaces (one per kind)
// ---------------------------------------------------------------------------

/** Turn lifecycle begins. Exactly one per producer turn. */
export interface TurnStartEvent extends EnvelopeFields {
  kind: "turn.start";
}

/** Turn lifecycle ends. Carries the authoritative StopReason. */
export interface TurnEndEvent extends EnvelopeFields {
  kind: "turn.end";
  stopReason: StopReason;
}

/** Streaming assistant text delta. Concatenated by consumers, never rewritten. */
export interface DeltaTextEvent extends EnvelopeFields {
  kind: "delta.text";
  text: string;
}

/** Streaming assistant reasoning/thinking delta (rendered distinctly from text). */
export interface DeltaThinkingEvent extends EnvelopeFields {
  kind: "delta.thinking";
  text: string;
}

/** Tool invocation begins. `id` is unique within the session. */
export interface ToolStartEvent extends EnvelopeFields {
  kind: "tool.start";
  id: string;
  name: string;
  /** Human-readable summary of the args for row rendering. May be empty. */
  argsSummary: string;
}

/** Progress update on a running tool. `delta` semantics are producer-defined text. */
export interface ToolUpdateEvent extends EnvelopeFields {
  kind: "tool.update";
  id: string;
  delta: string;
}

/** Tool invocation finished. Failed tools stay folded in UIs; detail carries why. */
export interface ToolEndEvent extends EnvelopeFields {
  kind: "tool.end";
  id: string;
  status: ToolOutcome;
  /** Optional human-readable closing detail (e.g. failure message). */
  detail?: string | undefined;
}

/**
 * Per-call (or aggregated) token/cost accounting. Emitted after the calls it
 * describes settle. Cost honesty rules live on {@link Usage}.
 */
export interface UsageEvent extends EnvelopeFields {
  kind: "usage";
  usage: Usage;
}

/** A narration stage opens. Sliding-window stage narration, 2–5 stages per turn. */
export interface StageOpenEvent extends EnvelopeFields {
  kind: "stage.open";
  id: string;
  label: string;
}

/**
 * The previously open stage is retitled before/while the next opens — part of
 * the sliding-window contract (`summary` closes+rewrites the prior stage).
 */
export interface StageRewriteEvent extends EnvelopeFields {
  kind: "stage.rewrite";
  id: string;
  label: string;
}

/** A narration stage closes (completed, not failed). */
export interface StageCloseEvent extends EnvelopeFields {
  kind: "stage.close";
  id: string;
}

/**
 * Terminal error surfaced AFTER retries have settled — one transient 429 must
 * never paint N red blocks downstream. Producers MUST only emit this once they
 * have exhausted their retry budget; `retryable` is always exactly `false`.
 */
export interface ErrorEvent extends EnvelopeFields {
  kind: "error";
  message: string;
  retryable: false;
}

/** Permission needed to run something. Resolved by exactly one permission.resolve. */
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

/** Resolution of a prior permission.request with the same id. */
export interface PermissionResolveEvent extends EnvelopeFields {
  kind: "permission.resolve";
  id: string;
  decision: PermissionDecision;
}

/** Kernel-owned queue state changed (typing-while-streaming, steering, interrupt-pause). */
export interface QueueChangedEvent extends EnvelopeFields {
  kind: "queue.changed";
  queued: number;
  /** True when entries are held because an interrupt paused the loop. */
  heldAfterInterrupt: boolean;
}

/** A checkpoint landed; `ref` is opaque, `n` is the running count within the session. */
export interface CheckpointCreatedEvent extends EnvelopeFields {
  kind: "checkpoint.created";
  ref: string;
  n: number;
}

/**
 * Structural routing decided which model serves this segment. Surfaces show
 * route REASONS — never savings deltas; savings remain inferred until a
 * holdout measures them, and this event never claims otherwise.
 */
export interface RouteDecidedEvent extends EnvelopeFields {
  kind: "route.decided";
  model: string;
  reason: string;
  signals: string[];
}

/** Budget ceiling hit; the run stopped instead of spending past the cap. */
export interface BudgetStoppedEvent extends EnvelopeFields {
  kind: "budget.stopped";
  estimateUsd: number;
  leftUsd: number;
  message: string;
}

/**
 * Compaction started/completed for this session. When present,
 * firstKeptEntryId points at the oldest surviving original entry — everything
 * before it is represented by a summary entry (role "summary") written to
 * session storage.
 */
export interface SessionCompactingEvent extends EnvelopeFields {
  kind: "session.compacting";
  firstKeptEntryId?: string | undefined;
}

// ---------------------------------------------------------------------------
// Kind list + discriminated union
// ---------------------------------------------------------------------------

/** Every event kind, fixed order. Golden fixtures under fixtures/ mirror this 1:1. */
export const ALL_EVENT_KINDS = [
  "turn.start",
  "turn.end",
  "delta.text",
  "delta.thinking",
  "tool.start",
  "tool.update",
  "tool.end",
  "usage",
  "stage.open",
  "stage.rewrite",
  "stage.close",
  "error",
  "permission.request",
  "permission.resolve",
  "queue.changed",
  "checkpoint.created",
  "route.decided",
  "budget.stopped",
  "session.compacting",
] as const;

export type TurnEventKind = (typeof ALL_EVENT_KINDS)[number];

/**
 * The full turn-event union. Discriminate on `kind`.
 */
export type TurnEvent =
  | TurnStartEvent
  | TurnEndEvent
  | DeltaTextEvent
  | DeltaThinkingEvent
  | ToolStartEvent
  | ToolUpdateEvent
  | ToolEndEvent
  | UsageEvent
  | StageOpenEvent
  | StageRewriteEvent
  | StageCloseEvent
  | ErrorEvent
  | PermissionRequestEvent
  | PermissionResolveEvent
  | QueueChangedEvent
  | CheckpointCreatedEvent
  | RouteDecidedEvent
  | BudgetStoppedEvent
  | SessionCompactingEvent;

// Compile-time exhaustiveness: fails to compile if the union and the kind
// tuple ever drift apart in either direction.
type UnionKinds<T> = T extends { kind: infer K } ? K : never;
type _KindDrift =
  | Exclude<TurnEventKind, UnionKinds<TurnEvent>>
  | Exclude<UnionKinds<TurnEvent>, TurnEventKind>;
const _NO_KIND_DRIFT: readonly _KindDrift[] = [];

// ---------------------------------------------------------------------------
// Runtime validators (hand-rolled, zero dependencies)
// ---------------------------------------------------------------------------

/** RFC 3339 timestamp with mandatory date, seconds, timezone. */
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isAnyString(value: unknown): value is string {
  return typeof value === "string";
}

/** Non-negative integer (token counts, seq numbers, counters). */
function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Non-negative finite number (money amounts). */
function isAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isIsoTimestamp(value: unknown): value is string {
  return isAnyString(value) && RFC3339.test(value);
}

/** Narrow to a StopReason. Exact six-value membership; anything else is rejected. */
export function isStopReason(value: unknown): value is StopReason {
  return (
    isAnyString(value) &&
    (STOP_REASONS as readonly string[]).includes(value)
  );
}

/** Narrow token/cost accounting. Rejects NaN, infinities, negative or fractional counts. */
export function isUsage(value: unknown): value is Usage {
  if (!isRecord(value)) return false;
  if (!isCount(value["in"])) return false;
  if (!isCount(value["out"])) return false;
  if (!isCount(value["cacheRead"])) return false;
  if (!isCount(value["cacheWrite"])) return false;
  if (value["costUsd"] !== null && !isAmount(value["costUsd"])) return false;
  if (!isNonEmptyString(value["model"])) return false;
  return true;
}

function hasOptionalString(
  record: Record<string, unknown>,
  key: string,
): boolean {
  return !(key in record) || isAnyString(record[key]);
}

function isEnvelope(record: Record<string, unknown>): boolean {
  return (
    record["v"] === 1 &&
    isCount(record["seq"]) &&
    isIsoTimestamp(record["ts"]) &&
    isNonEmptyString(record["sessionId"])
  );
}

/**
 * Validate one decoded frame against the frozen v1 event schema. Strict about
 * every documented field (types, enums, literals); tolerant ONLY of unknown
 * extra properties, so additive-minor producers keep older readers working.
 */
export function isTurnEvent(value: unknown): value is TurnEvent {
  if (!isRecord(value)) return false;
  if (!isEnvelope(value)) return false;
  const e: Record<string, unknown> = value;
  switch (e["kind"]) {
    case "turn.start":
      return true;
    case "turn.end":
      return isStopReason(e["stopReason"]);
    case "delta.text":
    case "delta.thinking":
      return isAnyString(e["text"]);
    case "tool.start":
      return (
        isNonEmptyString(e["id"]) &&
        isNonEmptyString(e["name"]) &&
        isAnyString(e["argsSummary"])
      );
    case "tool.update":
      return isNonEmptyString(e["id"]) && isAnyString(e["delta"]);
    case "tool.end":
      return (
        isNonEmptyString(e["id"]) &&
        isAnyString(e["status"]) &&
        (TOOL_OUTCOMES as readonly string[]).includes(e["status"]) &&
        hasOptionalString(e, "detail")
      );
    case "usage":
      return isUsage(e["usage"]);
    case "stage.open":
    case "stage.rewrite":
      return isNonEmptyString(e["id"]) && isNonEmptyString(e["label"]);
    case "stage.close":
      return isNonEmptyString(e["id"]);
    case "error": {
      // Post-retry-only by producer contract: retryable must be literally false.
      return isNonEmptyString(e["message"]) && e["retryable"] === false;
    }
    case "permission.request":
      return (
        isNonEmptyString(e["id"]) &&
        isNonEmptyString(e["tool"]) &&
        isNonEmptyString(e["plainLanguage"]) &&
        hasOptionalString(e, "detail")
      );
    case "permission.resolve":
      return (
        isNonEmptyString(e["id"]) &&
        isAnyString(e["decision"]) &&
        (PERMISSION_DECISIONS as readonly string[]).includes(e["decision"])
      );
    case "queue.changed":
      return (
        isCount(e["queued"]) && typeof e["heldAfterInterrupt"] === "boolean"
      );
    case "checkpoint.created":
      return isNonEmptyString(e["ref"]) && isCount(e["n"]);
    case "route.decided":
      return (
        isNonEmptyString(e["model"]) &&
        isNonEmptyString(e["reason"]) &&
        Array.isArray(e["signals"]) &&
        e["signals"].every((s) => isNonEmptyString(s))
      );
    case "budget.stopped":
      return (
        isAmount(e["estimateUsd"]) &&
        isAmount(e["leftUsd"]) &&
        isNonEmptyString(e["message"])
      );
    case "session.compacting":
      return hasOptionalString(e, "firstKeptEntryId");
    default:
      return false;
  }
}
