import {
  isTurnEvent,
  type StopReason,
  type TurnEndEvent,
  type TurnEvent,
} from "./events.ts";

/** Default cap on concurrently open stage/tool lifecycles. */
export const DEFAULT_MAX_OPEN_LIFECYCLES = 1_024;
/** Default cap on distinct lifecycle ids retained for one validated turn. */
export const DEFAULT_MAX_SEEN_LIFECYCLE_IDS = 4_096;
/** Default cap on tool-call identities retained across one session stream. */
export const DEFAULT_MAX_SEEN_SESSION_TOOL_IDS = 65_536;
/** Default cap on UTF-8 bytes retained for session/lifecycle identity. */
export const DEFAULT_MAX_RETAINED_IDENTITY_BYTES = 1_048_576;

export const TURN_EVENT_SEQUENCE_ERROR_CODES = [
  "pebble_sequence_invalid_options",
  "pebble_sequence_invalid_event",
  "pebble_sequence_session_mismatch",
  "pebble_sequence_number_mismatch",
  "pebble_sequence_turn_start_required",
  "pebble_sequence_turn_start_duplicate",
  "pebble_sequence_lifecycle_duplicate",
  "pebble_sequence_lifecycle_not_open",
  "pebble_sequence_open_limit",
  "pebble_sequence_seen_limit",
  "pebble_sequence_identity_bytes_limit",
  "pebble_sequence_error_order",
  "pebble_sequence_terminal_mismatch",
  "pebble_sequence_terminal_duplicate",
  "pebble_sequence_event_after_terminal",
  "pebble_sequence_dangling_lifecycles",
  "pebble_sequence_terminal_missing",
  "pebble_sequence_stream_finished",
] as const;

export type TurnEventSequenceErrorCode =
  (typeof TURN_EVENT_SEQUENCE_ERROR_CODES)[number];

/** Machine-readable protocol-sequence failure. A failed validator stays failed. */
export class TurnEventSequenceError extends Error {
  readonly code: TurnEventSequenceErrorCode;
  readonly eventKind: string | null;
  readonly seq: number | null;

  constructor(
    code: TurnEventSequenceErrorCode,
    message: string,
    event?: Readonly<{ kind: string; seq: number }> | undefined,
  ) {
    super(`${code}: ${message}`);
    this.name = "TurnEventSequenceError";
    this.code = code;
    this.eventKind = event?.kind ?? null;
    this.seq = event?.seq ?? null;
  }
}

/**
 * One validator represents exactly one turn on one session stream.
 * `firstSeq` lets callers validate a later turn in a session-wide sequence.
 * Use SessionEventSequenceCoordinator when validating a complete session and
 * enforcing tool-id uniqueness across turns.
 */
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

/** Evidence returned only after one complete, valid turn. */
export interface TurnEventSequenceSummary {
  readonly sessionId: string;
  readonly firstSeq: number;
  readonly lastSeq: number;
  readonly eventCount: number;
  readonly stopReason: StopReason;
  readonly errorEventSeen: boolean;
  readonly peakOpenLifecycles: number;
}

/** Bounds for one complete session stream beginning at sequence zero. */
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

/** Bounded aggregate evidence returned after a complete session stream. */
export interface SessionEventSequenceSummary {
  readonly sessionId: string;
  readonly firstSeq: 0;
  readonly lastSeq: number;
  readonly eventCount: number;
  readonly turnCount: number;
  readonly toolCallCount: number;
  readonly peakOpenLifecycles: number;
}

type LifecycleKind = "stage" | "tool";

const UTF8_ENCODER = new TextEncoder();
const MAX_DIAGNOSTIC_ID_CHARS = 128;
const MAX_DIAGNOSTIC_IDS = 8;
const MAX_EVENT_SNAPSHOT_DEPTH = 32;
const MAX_EVENT_SNAPSHOT_NODES = 100_000;
const MAX_EVENT_SNAPSHOT_STRING_BYTES = 16 * 1024 * 1024;
const OPTION_KEYS = Object.freeze([
  "firstSeq",
  "sessionId",
  "maxOpenLifecycles",
  "maxSeenLifecycleIds",
  "maxRetainedIdentityBytes",
]);
const SESSION_OPTION_KEYS = Object.freeze([
  "sessionId",
  "maxOpenLifecycles",
  "maxSeenLifecycleIds",
  "maxSeenToolCallIds",
  "maxRetainedIdentityBytes",
]);

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function optionError(message: string): TurnEventSequenceError {
  return new TurnEventSequenceError(
    "pebble_sequence_invalid_options",
    message,
  );
}

/**
 * Incremental, zero-dependency validator for one frozen-v1 turn stream.
 *
 * Legacy `permission.request/resolve` shapes are checked by `isTurnEvent` and
 * otherwise remain opaque. This validator adds no permission state machine.
 */
export class TurnEventSequenceValidator {
  readonly #firstSeq: number;
  readonly #maxOpenLifecycles: number;
  readonly #maxSeenLifecycleIds: number;
  readonly #maxRetainedIdentityBytes: number;
  readonly #open: Readonly<Record<LifecycleKind, Set<string>>> = {
    stage: new Set<string>(),
    tool: new Set<string>(),
  };
  readonly #seen: Readonly<Record<LifecycleKind, Set<string>>> = {
    stage: new Set<string>(),
    tool: new Set<string>(),
  };

  #sessionId: string | undefined;
  #retainedIdentityBytes = 0;
  #nextSeq: number;
  #eventCount = 0;
  #peakOpenLifecycles = 0;
  #started = false;
  #errorEventSeen = false;
  #terminalStopReason: StopReason | undefined;
  #finished = false;
  #failure: TurnEventSequenceError | undefined;
  #summary: TurnEventSequenceSummary | undefined;

  constructor(options: TurnEventSequenceValidatorOptions = {}) {
    const normalizedOptions = snapshotSequenceOptions(options);
    const firstSeq = normalizedOptions.firstSeq ?? 0;
    const maxOpenLifecycles =
      normalizedOptions.maxOpenLifecycles ?? DEFAULT_MAX_OPEN_LIFECYCLES;
    const maxSeenLifecycleIds =
      normalizedOptions.maxSeenLifecycleIds ?? DEFAULT_MAX_SEEN_LIFECYCLE_IDS;
    const maxRetainedIdentityBytes =
      normalizedOptions.maxRetainedIdentityBytes ?? DEFAULT_MAX_RETAINED_IDENTITY_BYTES;
    if (!isCount(firstSeq) || firstSeq === Number.MAX_SAFE_INTEGER) {
      throw optionError(
        "firstSeq must be a non-negative safe integer with room for turn.end",
      );
    }
    if (!isCount(maxOpenLifecycles)) {
      throw optionError(
        "maxOpenLifecycles must be a non-negative safe integer",
      );
    }
    if (!isCount(maxSeenLifecycleIds)) {
      throw optionError(
        "maxSeenLifecycleIds must be a non-negative safe integer",
      );
    }
    if (!isCount(maxRetainedIdentityBytes)) {
      throw optionError(
        "maxRetainedIdentityBytes must be a non-negative safe integer",
      );
    }
    if (
      normalizedOptions.sessionId !== undefined &&
      (typeof normalizedOptions.sessionId !== "string" || normalizedOptions.sessionId.length === 0)
    ) {
      throw optionError("sessionId must be a non-empty string when provided");
    }
    this.#firstSeq = firstSeq;
    this.#nextSeq = firstSeq;
    this.#maxOpenLifecycles = maxOpenLifecycles;
    this.#maxSeenLifecycleIds = maxSeenLifecycleIds;
    this.#maxRetainedIdentityBytes = maxRetainedIdentityBytes;
    if (normalizedOptions.sessionId !== undefined) {
      const bytes = identityBytesBounded(
        normalizedOptions.sessionId,
        maxRetainedIdentityBytes,
      );
      if (bytes > maxRetainedIdentityBytes) {
        throw optionError(
          "sessionId exceeds maxRetainedIdentityBytes",
        );
      }
      this.#retainedIdentityBytes = bytes;
    }
    this.#sessionId = normalizedOptions.sessionId;
  }

  /** Next contiguous sequence number required by push(). */
  get nextSeq(): number {
    return this.#nextSeq;
  }

  /** Locked session identity, or undefined before first event without an option. */
  get sessionId(): string | undefined {
    return this.#sessionId;
  }

  /** Number of currently open structural lifecycles. */
  get openLifecycleCount(): number {
    return this.#openCount();
  }

  /** Number of distinct structural lifecycle ids retained for this turn. */
  get seenLifecycleIdCount(): number {
    return this.#seenCount();
  }

  /** True only after finish()/end() accepted a complete terminal turn. */
  get finished(): boolean {
    return this.#finished;
  }

  /**
   * Validate and accept one event. Returns a detached, frozen schema-narrowed
   * snapshot; caller mutation cannot rewrite accepted sequence evidence.
   * Any failure poisons this validator so callers cannot silently resync.
   */
  push(value: unknown): TurnEvent {
    if (this.#failure !== undefined) throw this.#failure;
    if (this.#finished) {
      return this.#fail(
        "pebble_sequence_stream_finished",
        "cannot push after finish/end",
      );
    }
    let event: TurnEvent;
    try {
      event = snapshotTurnEvent(value);
    } catch {
      return this.#fail(
        "pebble_sequence_invalid_event",
        "value is not a valid frozen-v1 TurnEvent",
      );
    }
    if (!isTurnEvent(event)) {
      return this.#fail(
        "pebble_sequence_invalid_event",
        "value is not a valid frozen-v1 TurnEvent",
      );
    }
    if (this.#terminalStopReason !== undefined) {
      return this.#fail(
        event.kind === "turn.end" || event.kind === "error"
          ? "pebble_sequence_terminal_duplicate"
          : "pebble_sequence_event_after_terminal",
        `event ${event.kind} followed terminal turn.end`,
        event,
      );
    }

    this.#validateEnvelope(event);
    this.#validateLifecycle(event);
    this.#eventCount += 1;
    this.#nextSeq += 1;
    return event;
  }

  /** Close input and return immutable evidence for one complete turn. */
  finish(): TurnEventSequenceSummary {
    if (this.#failure !== undefined) throw this.#failure;
    if (this.#summary !== undefined) return this.#summary;
    if (!this.#started) {
      return this.#fail(
        "pebble_sequence_turn_start_required",
        "stream ended before turn.start",
      );
    }
    if (this.#terminalStopReason === undefined) {
      const open = this.#openCount();
      if (open > 0) {
        return this.#fail(
          "pebble_sequence_dangling_lifecycles",
          this.#openDescription(),
        );
      }
      if (this.#errorEventSeen) {
        return this.#fail(
          "pebble_sequence_terminal_mismatch",
          "terminal error event must be followed by turn.end with stopReason error",
        );
      }
      return this.#fail(
        "pebble_sequence_terminal_missing",
        "stream ended before turn.end",
      );
    }

    const sessionId = this.#sessionId;
    if (sessionId === undefined) {
      // Unreachable after a valid turn.start; keep evidence construction closed.
      return this.#fail(
        "pebble_sequence_session_mismatch",
        "terminal stream has no locked session identity",
      );
    }
    this.#finished = true;
    this.#summary = Object.freeze({
      sessionId,
      firstSeq: this.#firstSeq,
      lastSeq: this.#nextSeq - 1,
      eventCount: this.#eventCount,
      stopReason: this.#terminalStopReason,
      errorEventSeen: this.#errorEventSeen,
      peakOpenLifecycles: this.#peakOpenLifecycles,
    });
    return this.#summary;
  }

  /** Alias for stream APIs that signal completion with end(). */
  end(): TurnEventSequenceSummary {
    return this.finish();
  }

  #validateEnvelope(event: TurnEvent): void {
    if (!Number.isSafeInteger(event.seq)) {
      this.#fail(
        "pebble_sequence_number_mismatch",
        `seq ${event.seq} is not a safe integer`,
        event,
      );
    }
    if (this.#sessionId === undefined) {
      const bytes = identityBytesBounded(
        event.sessionId,
        this.#maxRetainedIdentityBytes,
      );
      if (bytes > this.#maxRetainedIdentityBytes) {
        this.#fail(
          "pebble_sequence_identity_bytes_limit",
          `session identity exceeds maxRetainedIdentityBytes ${this.#maxRetainedIdentityBytes}`,
          event,
        );
      }
      this.#sessionId = event.sessionId;
      this.#retainedIdentityBytes = bytes;
    } else if (event.sessionId !== this.#sessionId) {
      this.#fail(
        "pebble_sequence_session_mismatch",
        `expected session ${diagnosticId(this.#sessionId)}, received ${diagnosticId(event.sessionId)}`,
        event,
      );
    }
    if (event.seq !== this.#nextSeq) {
      this.#fail(
        "pebble_sequence_number_mismatch",
        `expected seq ${this.#nextSeq}, received ${event.seq}`,
        event,
      );
    }
    if (event.seq === Number.MAX_SAFE_INTEGER && event.kind !== "turn.end") {
      this.#fail(
        "pebble_sequence_number_mismatch",
        "non-terminal event leaves no safely representable next seq",
        event,
      );
    }
  }

  #validateLifecycle(event: TurnEvent): void {
    if (!this.#started) {
      if (event.kind !== "turn.start") {
        this.#fail(
          "pebble_sequence_turn_start_required",
          `first event must be turn.start, received ${event.kind}`,
          event,
        );
      }
      this.#started = true;
      return;
    }
    if (event.kind === "turn.start") {
      this.#fail(
        "pebble_sequence_turn_start_duplicate",
        "one validator accepts exactly one turn.start",
        event,
      );
    }
    if (this.#errorEventSeen && event.kind !== "turn.end") {
      this.#fail(
        event.kind === "error"
          ? "pebble_sequence_terminal_duplicate"
          : "pebble_sequence_error_order",
        `terminal error must be followed immediately by turn.end, received ${event.kind}`,
        event,
      );
    }

    switch (event.kind) {
      case "stage.open":
        this.#openLifecycle("stage", event.id, event);
        return;
      case "stage.rewrite":
        this.#requireOpen("stage", event.id, event);
        return;
      case "stage.close":
        this.#closeLifecycle("stage", event.id, event);
        return;
      case "tool.start":
        this.#openLifecycle("tool", event.id, event);
        return;
      case "tool.update":
        this.#requireOpen("tool", event.id, event);
        return;
      case "tool.end":
        this.#closeLifecycle("tool", event.id, event);
        return;
      case "error":
        this.#errorEventSeen = true;
        return;
      case "turn.end":
        this.#acceptTerminal(event);
        return;
      default:
        return;
    }
  }

  #acceptTerminal(event: TurnEndEvent): void {
    if (this.#errorEventSeen !== (event.stopReason === "error")) {
      this.#fail(
        "pebble_sequence_terminal_mismatch",
        this.#errorEventSeen
          ? "terminal error requires turn.end stopReason error"
          : "turn.end stopReason error requires one preceding terminal error event",
        event,
      );
    }
    if (this.#openCount() > 0) {
      this.#fail(
        "pebble_sequence_dangling_lifecycles",
        this.#openDescription(),
        event,
      );
    }
    this.#terminalStopReason = event.stopReason;
  }

  #openLifecycle(
    kind: LifecycleKind,
    id: string,
    event: TurnEvent,
  ): void {
    const open = this.#open[kind];
    if (this.#seen[kind].has(id)) {
      this.#fail(
        "pebble_sequence_lifecycle_duplicate",
        `${kind} ${diagnosticId(id)} already appeared in this turn`,
        event,
      );
    }
    const openCount = this.#openCount();
    if (openCount >= this.#maxOpenLifecycles) {
      this.#fail(
        "pebble_sequence_open_limit",
        `opening ${kind} ${diagnosticId(id)} exceeds maxOpenLifecycles ${this.#maxOpenLifecycles}`,
        event,
      );
    }
    const seenCount = this.#seenCount();
    if (seenCount >= this.#maxSeenLifecycleIds) {
      this.#fail(
        "pebble_sequence_seen_limit",
        `tracking ${kind} ${diagnosticId(id)} exceeds maxSeenLifecycleIds ${this.#maxSeenLifecycleIds}`,
        event,
      );
    }
    const remainingIdentityBytes = this.#maxRetainedIdentityBytes -
      this.#retainedIdentityBytes;
    const idBytes = identityBytesBounded(id, remainingIdentityBytes);
    if (this.#retainedIdentityBytes + idBytes > this.#maxRetainedIdentityBytes) {
      this.#fail(
        "pebble_sequence_identity_bytes_limit",
        `tracking ${kind} ${diagnosticId(id)} exceeds maxRetainedIdentityBytes ${this.#maxRetainedIdentityBytes}`,
        event,
      );
    }
    this.#seen[kind].add(id);
    open.add(id);
    this.#retainedIdentityBytes += idBytes;
    this.#peakOpenLifecycles = Math.max(
      this.#peakOpenLifecycles,
      openCount + 1,
    );
  }

  #requireOpen(
    kind: LifecycleKind,
    id: string,
    event: TurnEvent,
  ): void {
    if (!this.#open[kind].has(id)) {
      this.#fail(
        "pebble_sequence_lifecycle_not_open",
        `${kind} ${diagnosticId(id)} is not open`,
        event,
      );
    }
  }

  #closeLifecycle(
    kind: LifecycleKind,
    id: string,
    event: TurnEvent,
  ): void {
    this.#requireOpen(kind, id, event);
    this.#open[kind].delete(id);
  }

  #openCount(): number {
    return (
      this.#open.stage.size +
      this.#open.tool.size
    );
  }

  #seenCount(): number {
    return (
      this.#seen.stage.size +
      this.#seen.tool.size
    );
  }

  #openDescription(): string {
    const describe = (kind: LifecycleKind): string => {
      const ids = [...this.#open[kind]];
      const shown = ids.slice(0, MAX_DIAGNOSTIC_IDS).map(diagnosticId).join(",");
      const omitted = ids.length - Math.min(ids.length, MAX_DIAGNOSTIC_IDS);
      return `${kind}=[${shown}${omitted === 0 ? "" : `,...+${omitted}`}]`;
    };
    return `turn has dangling lifecycles: ${describe("stage")} ${describe("tool")}`;
  }

  #fail(
    code: TurnEventSequenceErrorCode,
    message: string,
    event?: Readonly<{ kind: string; seq: number }> | undefined,
  ): never {
    const error = new TurnEventSequenceError(code, message, event);
    this.#failure = error;
    throw error;
  }
}

/**
 * Coordinates complete turns into one bounded frozen-v1 session stream.
 *
 * Exactly one TurnEventSequenceValidator is live at a time. Completed turn
 * validators are discarded after their frozen summary is folded into bounded
 * aggregate evidence. Only tool-call ids remain retained across turns because
 * the frozen event contract requires those ids to be unique per session.
 *
 * Legacy permission events remain opaque schema-valid events. They create no
 * coordinator state and repeated permission ids have no lifecycle semantics.
 */
export class SessionEventSequenceCoordinator {
  readonly #turnLimits: Readonly<{
    maxOpenLifecycles: number;
    maxSeenLifecycleIds: number;
    maxRetainedIdentityBytes: number;
  }>;
  readonly #maxSeenToolCallIds: number;
  readonly #maxRetainedIdentityBytes: number;
  readonly #seenToolCallIds = new Set<string>();

  #sessionId: string | undefined;
  #retainedIdentityBytes = 0;
  #nextSeq = 0;
  #eventCount = 0;
  #turnCount = 0;
  #peakOpenLifecycles = 0;
  #currentTurn: TurnEventSequenceValidator | undefined;
  #latestTurnSummary: TurnEventSequenceSummary | undefined;
  #finished = false;
  #failure: TurnEventSequenceError | undefined;
  #summary: SessionEventSequenceSummary | undefined;

  constructor(options: SessionEventSequenceCoordinatorOptions = {}) {
    const normalizedOptions = snapshotSessionSequenceOptions(options);
    const maxOpenLifecycles =
      normalizedOptions.maxOpenLifecycles ?? DEFAULT_MAX_OPEN_LIFECYCLES;
    const maxSeenLifecycleIds =
      normalizedOptions.maxSeenLifecycleIds ?? DEFAULT_MAX_SEEN_LIFECYCLE_IDS;
    const maxSeenToolCallIds =
      normalizedOptions.maxSeenToolCallIds ?? DEFAULT_MAX_SEEN_SESSION_TOOL_IDS;
    const maxRetainedIdentityBytes =
      normalizedOptions.maxRetainedIdentityBytes ?? DEFAULT_MAX_RETAINED_IDENTITY_BYTES;
    if (!isCount(maxOpenLifecycles)) {
      throw optionError(
        "maxOpenLifecycles must be a non-negative safe integer",
      );
    }
    if (!isCount(maxSeenLifecycleIds)) {
      throw optionError(
        "maxSeenLifecycleIds must be a non-negative safe integer",
      );
    }
    if (!isCount(maxSeenToolCallIds)) {
      throw optionError(
        "maxSeenToolCallIds must be a non-negative safe integer",
      );
    }
    if (!isCount(maxRetainedIdentityBytes)) {
      throw optionError(
        "maxRetainedIdentityBytes must be a non-negative safe integer",
      );
    }
    if (
      normalizedOptions.sessionId !== undefined &&
      (typeof normalizedOptions.sessionId !== "string" || normalizedOptions.sessionId.length === 0)
    ) {
      throw optionError("sessionId must be a non-empty string when provided");
    }
    if (normalizedOptions.sessionId !== undefined) {
      const bytes = identityBytesBounded(
        normalizedOptions.sessionId,
        maxRetainedIdentityBytes,
      );
      if (bytes > maxRetainedIdentityBytes) {
        throw optionError("sessionId exceeds maxRetainedIdentityBytes");
      }
      this.#retainedIdentityBytes = bytes;
    }
    this.#sessionId = normalizedOptions.sessionId;
    this.#maxSeenToolCallIds = maxSeenToolCallIds;
    this.#maxRetainedIdentityBytes = maxRetainedIdentityBytes;
    this.#turnLimits = Object.freeze({
      maxOpenLifecycles,
      maxSeenLifecycleIds,
      maxRetainedIdentityBytes,
    });
  }

  /** Next contiguous sequence number required by push(). */
  get nextSeq(): number {
    return this.#nextSeq;
  }

  /** Locked session identity, or undefined before first accepted event. */
  get sessionId(): string | undefined {
    return this.#sessionId;
  }

  /** Number of completed turns folded into aggregate evidence. */
  get turnCount(): number {
    return this.#turnCount;
  }

  /** Number of session-wide tool-call identities retained. */
  get seenToolCallIdCount(): number {
    return this.#seenToolCallIds.size;
  }

  /** Most recently completed immutable turn summary. */
  get latestTurnSummary(): TurnEventSequenceSummary | undefined {
    return this.#latestTurnSummary;
  }

  /** True only after finish()/end() accepted one or more complete turns. */
  get finished(): boolean {
    return this.#finished;
  }

  /**
   * Validate one event and return a detached, frozen snapshot. Any turn or
   * session failure poisons the coordinator so callers cannot silently resync.
   */
  push(value: unknown): TurnEvent {
    if (this.#failure !== undefined) throw this.#failure;
    if (this.#finished) {
      return this.#fail(
        "pebble_sequence_stream_finished",
        "cannot push after finish/end",
      );
    }
    if (this.#currentTurn === undefined) {
      try {
        this.#currentTurn = new TurnEventSequenceValidator({
          firstSeq: this.#nextSeq,
          ...(this.#sessionId === undefined ? {} : { sessionId: this.#sessionId }),
          ...this.#turnLimits,
        });
      } catch (error) {
        return this.#poison(error);
      }
    }

    let accepted: TurnEvent;
    try {
      accepted = this.#currentTurn.push(value);
    } catch (error) {
      return this.#poison(error);
    }
    if (this.#sessionId === undefined) {
      const bytes = identityBytesBounded(
        accepted.sessionId,
        this.#maxRetainedIdentityBytes,
      );
      if (bytes > this.#maxRetainedIdentityBytes) {
        return this.#fail(
          "pebble_sequence_identity_bytes_limit",
          `session identity exceeds maxRetainedIdentityBytes ${this.#maxRetainedIdentityBytes}`,
          accepted,
        );
      }
      this.#sessionId = accepted.sessionId;
      this.#retainedIdentityBytes = bytes;
    }
    if (accepted.kind === "tool.start") {
      this.#retainToolCallId(accepted.id, accepted);
    }

    this.#eventCount += 1;
    this.#nextSeq += 1;
    if (accepted.kind === "turn.end") {
      let turnSummary: TurnEventSequenceSummary;
      try {
        turnSummary = this.#currentTurn.finish();
      } catch (error) {
        return this.#poison(error);
      }
      this.#turnCount += 1;
      this.#peakOpenLifecycles = Math.max(
        this.#peakOpenLifecycles,
        turnSummary.peakOpenLifecycles,
      );
      this.#latestTurnSummary = turnSummary;
      this.#currentTurn = undefined;
    }
    return accepted;
  }

  /** Close input and return immutable bounded evidence for the session. */
  finish(): SessionEventSequenceSummary {
    if (this.#failure !== undefined) throw this.#failure;
    if (this.#summary !== undefined) return this.#summary;
    if (this.#currentTurn !== undefined) {
      try {
        this.#currentTurn.finish();
      } catch (error) {
        return this.#poison(error);
      }
      return this.#fail(
        "pebble_sequence_terminal_missing",
        "active turn did not close before session end",
      );
    }
    if (this.#turnCount === 0) {
      return this.#fail(
        "pebble_sequence_turn_start_required",
        "session stream ended before turn.start",
      );
    }
    const sessionId = this.#sessionId;
    if (sessionId === undefined) {
      return this.#fail(
        "pebble_sequence_session_mismatch",
        "completed session stream has no locked identity",
      );
    }
    this.#finished = true;
    this.#summary = Object.freeze({
      sessionId,
      firstSeq: 0 as const,
      lastSeq: this.#nextSeq - 1,
      eventCount: this.#eventCount,
      turnCount: this.#turnCount,
      toolCallCount: this.#seenToolCallIds.size,
      peakOpenLifecycles: this.#peakOpenLifecycles,
    });
    return this.#summary;
  }

  /** Alias for stream APIs that signal completion with end(). */
  end(): SessionEventSequenceSummary {
    return this.finish();
  }

  #retainToolCallId(id: string, event: TurnEvent): void {
    if (this.#seenToolCallIds.has(id)) {
      this.#fail(
        "pebble_sequence_lifecycle_duplicate",
        `tool ${diagnosticId(id)} already appeared in this session`,
        event,
      );
    }
    if (this.#seenToolCallIds.size >= this.#maxSeenToolCallIds) {
      this.#fail(
        "pebble_sequence_seen_limit",
        `tracking tool ${diagnosticId(id)} exceeds maxSeenToolCallIds ${this.#maxSeenToolCallIds}`,
        event,
      );
    }
    const remainingIdentityBytes = this.#maxRetainedIdentityBytes -
      this.#retainedIdentityBytes;
    const idBytes = identityBytesBounded(id, remainingIdentityBytes);
    if (this.#retainedIdentityBytes + idBytes > this.#maxRetainedIdentityBytes) {
      this.#fail(
        "pebble_sequence_identity_bytes_limit",
        `tracking tool ${diagnosticId(id)} exceeds maxRetainedIdentityBytes ${this.#maxRetainedIdentityBytes}`,
        event,
      );
    }
    this.#seenToolCallIds.add(id);
    this.#retainedIdentityBytes += idBytes;
  }

  #poison(error: unknown): never {
    const failure = error instanceof TurnEventSequenceError
      ? error
      : new TurnEventSequenceError(
        "pebble_sequence_invalid_event",
        "turn sequence validation failed closed",
      );
    this.#failure = failure;
    throw failure;
  }

  #fail(
    code: TurnEventSequenceErrorCode,
    message: string,
    event?: Readonly<{ kind: string; seq: number }> | undefined,
  ): never {
    const error = new TurnEventSequenceError(code, message, event);
    this.#failure = error;
    throw error;
  }
}

function identityBytesBounded(value: string, maximum: number): number {
  // One UTF-16 code unit always occupies at least one UTF-8 byte. Reject huge
  // input before TextEncoder allocates a second huge buffer merely to count it.
  if (value.length > maximum) return maximum + 1;
  return UTF8_ENCODER.encode(value).byteLength;
}

function diagnosticId(value: string): string {
  const shortened = value.length <= MAX_DIAGNOSTIC_ID_CHARS
    ? value
    : `${value.slice(0, MAX_DIAGNOSTIC_ID_CHARS)}...`;
  return JSON.stringify(shortened);
}

function snapshotSequenceOptions(
  value: unknown,
): TurnEventSequenceValidatorOptions {
  const source = ownDataDescriptors(value, "options");
  const keys = Reflect.ownKeys(source);
  if (keys.some((key) => typeof key !== "string" || !OPTION_KEYS.includes(key))) {
    throw optionError("options must contain only known own data fields");
  }
  const result: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    const descriptor = source[key];
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw optionError("options must contain only known own data fields");
    }
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: descriptor.value,
    });
  }
  return result as TurnEventSequenceValidatorOptions;
}

function snapshotSessionSequenceOptions(
  value: unknown,
): SessionEventSequenceCoordinatorOptions {
  let source: DescriptorMap;
  try {
    source = ownDataDescriptors(value, "session options");
  } catch {
    throw optionError("session options must be a plain object");
  }
  const keys = Reflect.ownKeys(source);
  if (keys.some((key) => typeof key !== "string" || !SESSION_OPTION_KEYS.includes(key))) {
    throw optionError("session options must contain only known own data fields");
  }
  const result: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    const descriptor = source[key];
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw optionError("session options must contain only known own data fields");
    }
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: descriptor.value,
    });
  }
  return result as SessionEventSequenceCoordinatorOptions;
}

function snapshotTurnEvent(value: unknown): TurnEvent {
  const state = { nodes: 0, stringBytes: 0, seen: new Set<object>() };
  const snapshot = snapshotJSONData(value, state, 0);
  return snapshot as TurnEvent;
}

function snapshotJSONData(
  value: unknown,
  state: { nodes: number; stringBytes: number; seen: Set<object> },
  depth: number,
): unknown {
  state.nodes += 1;
  if (state.nodes > MAX_EVENT_SNAPSHOT_NODES || depth > MAX_EVENT_SNAPSHOT_DEPTH) {
    throw new Error("event snapshot limit");
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("event snapshot number");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "string") {
    if (value.length > MAX_EVENT_SNAPSHOT_STRING_BYTES) {
      throw new Error("event snapshot string limit");
    }
    const bytes = UTF8_ENCODER.encode(value).byteLength;
    state.stringBytes += bytes;
    if (state.stringBytes > MAX_EVENT_SNAPSHOT_STRING_BYTES) {
      throw new Error("event snapshot string limit");
    }
    return value;
  }
  if (typeof value !== "object" || state.seen.has(value)) {
    throw new Error("event snapshot data");
  }
  state.seen.add(value);
  try {
    if (Array.isArray(value)) {
      const descriptors = ownArrayDataDescriptors(value);
      const length = descriptors.length?.value;
      if (!Number.isSafeInteger(length) || length < 0 ||
          length > MAX_EVENT_SNAPSHOT_NODES - state.nodes) {
        throw new Error("event snapshot array");
      }
      const keys = Reflect.ownKeys(descriptors);
      if (keys.some((key) => typeof key !== "string" ||
          (key !== "length" && !isArrayIndex(key, length)))) {
        throw new Error("event snapshot array");
      }
      const result: unknown[] = [];
      for (let index = 0; index < length; index++) {
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
          throw new Error("event snapshot array");
        }
        result.push(snapshotJSONData(descriptor.value, state, depth + 1));
      }
      return Object.freeze(result);
    }
    const descriptors = ownDataDescriptors(value, "event");
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length > MAX_EVENT_SNAPSHOT_NODES - state.nodes ||
        keys.some((key) => typeof key !== "string")) {
      throw new Error("event snapshot object");
    }
    const result: Record<string, unknown> = {};
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        throw new Error("event snapshot object");
      }
      Object.defineProperty(result, key, {
        configurable: false,
        enumerable: true,
        writable: false,
        value: snapshotJSONData(descriptor.value, state, depth + 1),
      });
    }
    return Object.freeze(result);
  } finally {
    state.seen.delete(value);
  }
}

function ownDataDescriptors(
  value: unknown,
  field: string,
): DescriptorMap {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be object`);
  }
  let prototype: object | null;
  let descriptors: DescriptorMap;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value) as DescriptorMap;
  } catch {
    throw new Error(`${field} must be plain data`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${field} must be plain data`);
  }
  return descriptors;
}

function ownArrayDataDescriptors(
  value: readonly unknown[],
): DescriptorMap {
  let prototype: object | null;
  let descriptors: DescriptorMap;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value) as unknown as DescriptorMap;
  } catch {
    throw new Error("event snapshot array");
  }
  if (prototype !== Array.prototype && prototype !== null) {
    throw new Error("event snapshot array");
  }
  return descriptors;
}

type DescriptorMap = Readonly<Record<PropertyKey, PropertyDescriptor>>;

function isArrayIndex(key: string, length: number): boolean {
  if (!/^(?:0|[1-9][0-9]*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
}
