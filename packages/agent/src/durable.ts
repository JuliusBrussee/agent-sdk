/**
 * Opt-in durable execution: an append-only per-run journal plus crash resume.
 *
 * Design provenance (founder decision 2026-08-15, issue #218): no embeddable
 * durable-execution library exists for TypeScript with a zero-infra local
 * story, so this file is the substrate — deliberately thin, borrowing the
 * proven parts of the field instead of inventing new semantics:
 *
 * - DBOS: checkpoint-resume (re-drive the run, skip completed work) rather
 *   than event-history diffing; caller-assigned run ID as the idempotency
 *   key; a run without a terminal journal event is PENDING and resumable;
 *   the honest guarantee is at-least-once at the step boundary.
 * - Inngest: journal events carry named identity and nothing is durable
 *   until the store acknowledges the write.
 * - Temporal: version identity lives in the journal itself; a definition
 *   digest mismatch on resume fails closed, never silently diverges.
 *
 * The ledger is event-sourced fine-grained (`call_started` intent before a
 * provider call, `call_settled` after), so a resume preloads the meter with
 * every journaled settle: settled money is never re-reserved and never lost.
 * Conversation state checkpoints at turn boundaries; a partial turn is
 * discarded on resume while its journaled spend is kept. A `call_started`
 * with no matching `call_settled` is the honest uncertainty window — the
 * provider may or may not have billed that in-flight call — and surfaces on
 * the receipt as `resume.possibleDoubleCountCalls`, never silently.
 *
 * The journal necessarily contains message content (unlike receipts, which
 * are content-blind): resuming a conversation requires the conversation.
 * The disk store therefore writes 0o700 directories and 0o600 files, the
 * same posture as `memory-store.ts`.
 */

import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { resolve } from "node:path";

/** Journal schema version. Bump on any incompatible event-shape change. */
export const DURABLE_JOURNAL_VERSION = 1;

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Caller-facing durable options on RunOptions. */
export interface DurableRunOptions {
  /**
   * Caller-assigned idempotency key for this run. The same runId always
   * refers to the same logical run: a crashed run resumes, a completed run
   * returns its journaled result without spending again, and a run that
   * ended in a terminal error re-reports that error. Filename-safe:
   * `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`.
   */
  runId: string;
  /**
   * Where the journal lives. Defaults to a disk store under
   * `<rootDir>/.caveman/runs/durable/`. Supply a custom store (e.g. a
   * database-backed one) for shared or production storage.
   */
  store?: DurableStore;
}

/**
 * Storage contract for run journals. Lines are opaque JSON strings; the
 * store guarantees ordered, durable appends — `append` resolving means the
 * data survives a process crash (fsync or the store's strongest equivalent).
 */
export interface DurableStore {
  /** Full journal for `runId`, in append order. Empty array when none exists. */
  load(runId: string): Promise<readonly string[]>;
  /** Durably append `data` (one or more newline-terminated lines). */
  append(runId: string, data: string): Promise<void>;
  /**
   * Take the exclusive per-run lock, so two processes cannot drive (and
   * double-spend) the same run. Returns the release function. Throws
   * `cave_durable_run_locked` when another live process holds it.
   */
  acquire(runId: string): Promise<() => Promise<void>>;
  /** Release any open handles for `runId`. Idempotent. */
  close(runId: string): Promise<void>;
}

export function validateDurableRunId(runId: string): void {
  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) {
    throw new Error(
      "cave_durable_run_id_invalid: durable.runId must match [A-Za-z0-9][A-Za-z0-9._-]{0,127}",
    );
  }
}

// ---------------------------------------------------------------------------
// Journal events
// ---------------------------------------------------------------------------

/**
 * `path` is the agent path of the emitter: "" for the root run, a
 * "/"-joined tool path for subagents. Money events from every depth land in
 * the ROOT journal so a resume can restore the whole tree's spend into the
 * root meter — each real provider call settles exactly once in exactly one
 * event, so summing settles never double-counts.
 */
interface JournalEventBase {
  v: number;
  at: string;
  type: string;
}

export interface RunStartedEvent extends JournalEventBase {
  type: "run_started";
  runId: string;
  agentId: string;
  definitionSha256: string;
  input: string;
  sessionId: string;
  denomination: "usd" | "tokens" | "none";
  budgetMax: number | undefined;
  /**
   * Digest of the FULL normalized budget (initial tranche, exhaustion mode,
   * output floor, compaction config — not just denomination and max), so a
   * resume under any different money contract fails closed.
   */
  budgetSha256: string;
  pid: number;
}

export interface ResumedEvent extends JournalEventBase {
  type: "resumed";
  attempt: number;
  unmatchedIntents: number;
  pid: number;
}

export interface CallStartedEvent extends JournalEventBase {
  type: "call_started";
  path: string;
  kind: "model" | "compaction";
  provider: string;
  model: string;
}

/** Mirrors the receipt's per-call shape so prior spend can be summarized honestly. */
export interface JournaledCallUsage {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  estimatedUsd: number;
  unpriced: boolean;
  usageBasis: "provider_reported" | "unavailable";
}

export interface CallSettledEvent extends JournalEventBase {
  type: "call_settled";
  path: string;
  kind: "model" | "compaction";
  call: JournaledCallUsage;
  /** Amount settled into the run's meter, in its denomination. Absent on unmetered runs. */
  settledAmount?: number;
}

export interface CallAbandonedEvent extends JournalEventBase {
  type: "call_abandoned";
  path: string;
}

export interface ToolEvent extends JournalEventBase {
  type: "tool";
  name: string;
  isError: boolean;
}

export interface TurnEvent extends JournalEventBase {
  type: "turn";
  messages: unknown[];
}

export interface SnapshotEvent extends JournalEventBase {
  type: "snapshot";
  messages: unknown[];
}

export interface TrancheEvent extends JournalEventBase {
  type: "tranche";
  amount: number;
  reason: string;
  atCall: number;
}

export interface RunCompletedEvent extends JournalEventBase {
  type: "run_completed";
  result: unknown;
}

export interface RunFailedEvent extends JournalEventBase {
  type: "run_failed";
  code: string;
  message: string;
  receipt: unknown;
}

export type DurableJournalEvent =
  | RunStartedEvent
  | ResumedEvent
  | CallStartedEvent
  | CallSettledEvent
  | CallAbandonedEvent
  | ToolEvent
  | TurnEvent
  | SnapshotEvent
  | TrancheEvent
  | RunCompletedEvent
  | RunFailedEvent;

// ---------------------------------------------------------------------------
// Disk store
// ---------------------------------------------------------------------------

/**
 * JSONL journal on local disk: `<root>/<runId>/journal.jsonl` plus a `lock`
 * file holding the owning pid. Appends fsync before resolving. This is the
 * dev/default store; production deployments that need shared storage supply
 * their own {@link DurableStore}.
 */
export class DiskDurableStore implements DurableStore {
  private readonly root: string;
  private readonly handles = new Map<string, Promise<FileHandle>>();

  constructor(root: string) {
    this.root = root;
  }

  private runDir(runId: string): string {
    validateDurableRunId(runId);
    // The directory name carries a digest suffix so two runIds that differ
    // only by case stay distinct journals on case-insensitive filesystems
    // (macOS/Windows defaults), and Windows reserved device names (`con`,
    // `nul`, …) never appear as a bare directory name. The caller's runId
    // remains the journaled identity.
    const digest = createHash("sha256").update(runId, "utf8").digest("hex").slice(0, 10);
    return resolve(this.root, `${runId}-${digest}`);
  }

  async load(runId: string): Promise<readonly string[]> {
    let raw: string;
    try {
      raw = await readFile(resolve(this.runDir(runId), "journal.jsonl"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    // A torn final line (crash mid-write) is expected, not corruption: every
    // complete line ends with \n, so anything after the last \n is discarded.
    const complete = raw.slice(0, raw.lastIndexOf("\n") + 1);
    return complete === "" ? [] : complete.slice(0, -1).split("\n");
  }

  private async handle(runId: string): Promise<FileHandle> {
    const existing = this.handles.get(runId);
    if (existing !== undefined) return existing;
    const opened = (async () => {
      const dir = this.runDir(runId);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      return open(resolve(dir, "journal.jsonl"), "a", 0o600);
    })();
    this.handles.set(runId, opened);
    try {
      return await opened;
    } catch (error) {
      this.handles.delete(runId);
      throw error;
    }
  }

  async append(runId: string, data: string): Promise<void> {
    const handle = await this.handle(runId);
    await handle.appendFile(data, "utf8");
    await handle.datasync();
  }

  async acquire(runId: string): Promise<() => Promise<void>> {
    const dir = this.runDir(runId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const lockDir = resolve(dir, "lock.d");
    const ownerPath = resolve(lockDir, "owner.json");
    const lockedError = () => new Error(
      `cave_durable_run_locked: run "${runId}" is already being driven by another process`,
    );
    // mkdir is the atomic primitive: exactly one process creates the lock
    // directory. The owner file lands after — a probe that reads the
    // directory before the file exists sees an unreadable owner and treats
    // the lock as held, which fails closed.
    const take = async (): Promise<void> => {
      try {
        await mkdir(lockDir, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw lockedError();
        throw error;
      }
      await writeFile(ownerPath, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
    };
    try {
      await take();
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("cave_durable_run_locked")) {
        throw error;
      }
      // A lock is stale when its owning process is gone (SIGKILL leaves it
      // behind). Unreadable owner = held: ambiguity fails closed rather than
      // risking two processes double-spending one run.
      let ownerAlive = true;
      try {
        const owner = JSON.parse(await readFile(ownerPath, "utf8")) as { pid?: number };
        if (typeof owner.pid === "number" && owner.pid !== process.pid) {
          try {
            process.kill(owner.pid, 0);
          } catch (signalError) {
            ownerAlive = (signalError as NodeJS.ErrnoException).code !== "ESRCH";
          }
        }
      } catch {
        ownerAlive = true;
      }
      if (ownerAlive) throw lockedError();
      // Single-winner takeover: rename is atomic, so of N processes that all
      // observed the same dead owner, exactly one moves the stale lock aside;
      // the losers surface the held-lock error instead of removing a LIVE
      // lock the winner just created (the rm-then-mkdir race).
      const reaped = resolve(dir, `lock.reaped-${process.pid}-${Math.floor(performance.now() * 1000)}`);
      try {
        await rename(lockDir, reaped);
      } catch {
        throw lockedError();
      }
      await rm(reaped, { recursive: true, force: true });
      await take();
    }
    return async () => {
      // Release only what this process still owns: another process may have
      // legitimately reaped a lock left behind by a crashed sibling with the
      // same pid file already gone.
      try {
        const owner = JSON.parse(await readFile(ownerPath, "utf8")) as { pid?: number };
        if (owner.pid !== process.pid) return;
      } catch {
        return;
      }
      await rm(lockDir, { recursive: true, force: true });
    };
  }

  async close(runId: string): Promise<void> {
    const pending = this.handles.get(runId);
    if (pending === undefined) return;
    this.handles.delete(runId);
    try {
      const handle = await pending;
      await handle.close();
    } catch {
      // Closing a handle that failed to open has nothing to release.
    }
  }
}

// ---------------------------------------------------------------------------
// Journal writer
// ---------------------------------------------------------------------------

/**
 * Serialized append pipeline over a {@link DurableStore}. `emit` queues
 * (stringifying immediately so an unserializable event fails at its source),
 * `flush` durably writes everything queued. Writes are chained: flush order
 * is emit order, and a flush resolves only when its own events are durable.
 */
export class DurableJournal {
  readonly runId: string;
  private readonly store: DurableStore;
  private queue: string[] = [];
  private chain: Promise<void> = Promise.resolve();
  // Sticky: once an append fails, this journal has a hole and must refuse to
  // keep recording (a resumed run would trust a ledger that stopped mid-run).
  // The chain itself never carries a rejection — an unobserved rejected
  // promise on a `void flush()` would take the whole process down.
  private failed: Error | undefined;

  constructor(store: DurableStore, runId: string) {
    this.store = store;
    this.runId = runId;
  }

  emit(event: DurableJournalEvent): void {
    let line: string;
    try {
      line = JSON.stringify(event);
      if (typeof line !== "string") throw new Error("not serializable");
    } catch {
      // A durable run whose evidence cannot be journaled must fail loudly at
      // the source; a silent skip would resume from a lying journal.
      throw new Error(`cave_durable_event_not_serializable: ${event.type}`);
    }
    this.queue.push(line);
  }

  flush(): Promise<void> {
    if (this.failed !== undefined) return Promise.reject(this.failed);
    if (this.queue.length === 0) return Promise.resolve();
    const batch = this.queue;
    this.queue = [];
    const data = batch.map((line) => `${line}\n`).join("");
    this.chain = this.chain.then(async () => {
      if (this.failed !== undefined) return;
      try {
        await this.store.append(this.runId, data);
      } catch (error) {
        this.failed = error instanceof Error ? error : new Error(String(error));
      }
    });
    return this.chain.then(() => {
      if (this.failed !== undefined) throw this.failed;
    });
  }

  now(): string {
    return new Date().toISOString();
  }
}

// ---------------------------------------------------------------------------
// Journal analysis (resume reconstruction)
// ---------------------------------------------------------------------------

export interface DurablePriorTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  estimatedUsd: number;
  totalTokens: number;
  unpriced: boolean;
  anyUsageUnavailable: boolean;
}

export interface DurableResumeState {
  attempts: number;
  sessionId: string;
  input: string;
  /** Conversation reconstructed to the last resumable boundary. Empty = start fresh. */
  messages: unknown[];
  /** Trailing journaled messages discarded because their turn never completed. */
  discardedPartialTurn: boolean;
  priorRootModelCalls: number;
  priorRootCompactions: number;
  priorToolEvents: ReadonlyArray<{ name: string; isError: boolean }>;
  priorSettled: number;
  priorTranches: ReadonlyArray<{ amount: number; reason: string; atCall: number }>;
  priorCalls: number;
  priorTotals: DurablePriorTotals;
  /**
   * Journaled provider-call intents that never settled or were abandoned.
   * Each is one call that may have been billed by the provider without this
   * ledger ever seeing its usage — the documented at-least-once ceiling.
   */
  possibleDoubleCountCalls: number;
}

export type DurableJournalState =
  | { status: "fresh" }
  | { status: "completed"; result: unknown }
  | { status: "failed"; code: string; message: string; receipt: unknown }
  | { status: "pending"; resume: DurableResumeState };

function parseEvents(lines: readonly string[]): DurableJournalEvent[] {
  const events: DurableJournalEvent[] = [];
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error("cave_durable_journal_corrupt: unparseable journal line");
    }
    const event = parsed as DurableJournalEvent;
    if (typeof event !== "object" || event === null || typeof event.type !== "string") {
      throw new Error("cave_durable_journal_corrupt: malformed journal event");
    }
    if (event.v !== DURABLE_JOURNAL_VERSION) {
      throw new Error(
        `cave_durable_journal_version_unsupported: journal v${String(event.v)}, this runtime reads v${DURABLE_JOURNAL_VERSION}`,
      );
    }
    events.push(event);
  }
  return events;
}

function messageRole(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const role = (message as { role?: unknown }).role;
  return typeof role === "string" ? role : undefined;
}

function corrupt(detail: string): Error {
  return new Error(`cave_durable_journal_corrupt: ${detail}`);
}

function requireMoney(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw corrupt(`invalid journaled ${field}`);
  }
  return value;
}

function requireTokens(value: unknown, field: string): number {
  const amount = requireMoney(value, field);
  if (!Number.isSafeInteger(amount)) throw corrupt(`invalid journaled ${field}`);
  return amount;
}

/**
 * Journaled money is still money: every figure that will reach a meter, a
 * RunResult total, or a receipt is validated with the same posture as
 * `BudgetMeter.restorePrior`, never trusted from disk. The store is a
 * pluggable trust boundary, not just a local file.
 */
function validateJournaledCall(value: unknown): JournaledCallUsage {
  if (typeof value !== "object" || value === null) {
    throw corrupt("call_settled without a call record");
  }
  const call = value as JournaledCallUsage;
  if (typeof call.provider !== "string" || typeof call.model !== "string") {
    throw corrupt("call_settled with a malformed identity");
  }
  requireTokens(call.inputTokens, "inputTokens");
  requireTokens(call.outputTokens, "outputTokens");
  requireTokens(call.cacheReadTokens, "cacheReadTokens");
  requireTokens(call.cacheWriteTokens, "cacheWriteTokens");
  requireTokens(call.reasoningTokens, "reasoningTokens");
  requireMoney(call.estimatedUsd, "estimatedUsd");
  if (typeof call.unpriced !== "boolean" ||
      (call.usageBasis !== "provider_reported" && call.usageBasis !== "unavailable")) {
    throw corrupt("call_settled with malformed flags");
  }
  return call;
}

/**
 * Minimal fail-closed shape check on a journaled terminal outcome before it
 * is replayed to a caller as a `RunResult`/`RunReceipt`. Not a full schema
 * pass — it pins the identity and every money-bearing field so a corrupted
 * or hostile store cannot mint arbitrary figures through the replay path.
 */
export function validateReplayResult(value: unknown, runId: string): void {
  if (typeof value !== "object" || value === null) throw corrupt("run_completed without a result");
  const result = value as Record<string, unknown>;
  if (result.runId !== runId || typeof result.agentId !== "string" ||
      typeof result.text !== "string") {
    throw corrupt("replayed result identity mismatch");
  }
  for (const field of [
    "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens",
    "reasoningTokens",
  ]) {
    requireTokens(result[field], `result.${field}`);
  }
  requireMoney(result.costUsd, "result.costUsd");
  validateReplayReceipt(result.receipt, runId);
}

export function validateReplayReceipt(value: unknown, runId: string): void {
  if (typeof value !== "object" || value === null) throw corrupt("terminal event without a receipt");
  const receipt = value as Record<string, unknown>;
  if (receipt.runId !== runId || receipt.schema !== "caveman.agent.run-receipt.v1") {
    throw corrupt("replayed receipt identity mismatch");
  }
  requireMoney(receipt.totalEstimatedUsd, "receipt.totalEstimatedUsd");
  requireTokens(receipt.totalTokens, "receipt.totalTokens");
}

/**
 * Classify a journal and, for a pending run, rebuild everything a resume
 * needs. `expected` is the CURRENT caller's identity; any mismatch with the
 * journaled identity fails closed — a resume must continue the same run, not
 * silently become a different one (Temporal's versioning lesson).
 */
export function analyzeJournal(
  lines: readonly string[],
  expected: {
    runId: string;
    definitionSha256: string;
    input: string;
    denomination: "usd" | "tokens" | "none";
    budgetMax: number | undefined;
    budgetSha256: string;
  },
): DurableJournalState {
  const events = parseEvents(lines);
  const started = events[0];
  if (started === undefined) return { status: "fresh" };
  if (started.type !== "run_started") {
    throw new Error("cave_durable_journal_corrupt: journal does not begin with run_started");
  }
  if (started.runId !== expected.runId) {
    throw new Error("cave_durable_journal_corrupt: journaled runId mismatch");
  }
  if (started.definitionSha256 !== expected.definitionSha256) {
    throw new Error(
      "cave_durable_definition_changed: the agent definition differs from the one this run started with — resume with the original definition, or use a new durable.runId",
    );
  }
  if (started.input !== expected.input) {
    throw new Error(
      "cave_durable_input_mismatch: this durable.runId was started with different input — a new task needs a new runId",
    );
  }
  if (started.denomination !== expected.denomination ||
      started.budgetMax !== expected.budgetMax ||
      started.budgetSha256 !== expected.budgetSha256) {
    throw new Error(
      "cave_durable_budget_changed: the budget differs from the one this run started with — a resume continues the original money contract",
    );
  }

  let attempts = 1;
  let base: unknown[] = [];
  let turns: unknown[][] = [];
  let intents = 0;
  let settles = 0;
  let abandoned = 0;
  let rootModelIntents = 0;
  let rootAbandoned = 0;
  let priorRootCompactions = 0;
  const priorToolEvents: Array<{ name: string; isError: boolean }> = [];
  let priorSettled = 0;
  const priorTranches: Array<{ amount: number; reason: string; atCall: number }> = [];
  const priorTotals: DurablePriorTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    estimatedUsd: 0,
    totalTokens: 0,
    unpriced: false,
    anyUsageUnavailable: false,
  };

  for (const event of events) {
    switch (event.type) {
      case "run_started":
        break;
      case "resumed":
        attempts += 1;
        break;
      case "call_started":
        intents += 1;
        if (event.path === "") {
          if (event.kind === "model") rootModelIntents += 1;
          else priorRootCompactions += 1;
        }
        break;
      case "call_settled": {
        settles += 1;
        if (event.settledAmount !== undefined) {
          priorSettled += requireMoney(event.settledAmount, "settledAmount");
        }
        const call = validateJournaledCall(event.call);
        priorTotals.inputTokens += call.inputTokens;
        priorTotals.outputTokens += call.outputTokens;
        priorTotals.cacheReadTokens += call.cacheReadTokens;
        priorTotals.cacheWriteTokens += call.cacheWriteTokens;
        priorTotals.reasoningTokens += call.reasoningTokens;
        priorTotals.estimatedUsd += call.estimatedUsd;
        priorTotals.totalTokens += call.inputTokens + call.outputTokens +
          call.cacheReadTokens + call.cacheWriteTokens;
        if (call.unpriced) priorTotals.unpriced = true;
        if (call.usageBasis === "unavailable") priorTotals.anyUsageUnavailable = true;
        break;
      }
      case "call_abandoned":
        abandoned += 1;
        if (event.path === "") rootAbandoned += 1;
        break;
      case "tool":
        if (typeof event.name !== "string" || typeof event.isError !== "boolean") {
          throw corrupt("malformed tool event");
        }
        priorToolEvents.push({ name: event.name, isError: event.isError });
        break;
      case "turn":
        if (!Array.isArray(event.messages)) throw corrupt("turn without a message array");
        turns.push(event.messages);
        break;
      case "snapshot":
        if (!Array.isArray(event.messages)) throw corrupt("snapshot without a message array");
        base = event.messages;
        turns = [];
        break;
      case "tranche":
        priorTranches.push({
          amount: requireMoney(event.amount, "tranche amount"),
          reason: typeof event.reason === "string" ? event.reason : "journaled",
          atCall: requireTokens(event.atCall, "tranche atCall"),
        });
        break;
      case "run_completed":
        validateReplayResult(event.result, expected.runId);
        return { status: "completed", result: event.result };
      case "run_failed":
        if (typeof event.code !== "string" || typeof event.message !== "string") {
          throw corrupt("malformed run_failed event");
        }
        validateReplayReceipt(event.receipt, expected.runId);
        return {
          status: "failed",
          code: event.code,
          message: event.message,
          receipt: event.receipt,
        };
      default:
        // Unknown event types fail closed: resuming past evidence this
        // runtime cannot read would rebuild a run it does not understand.
        throw new Error(
          `cave_durable_journal_event_unknown: ${(event as { type: string }).type}`,
        );
    }
  }

  // Trim to the last resumable boundary: `pi.continue()` requires the last
  // message to be a user or tool-result message, and anything after that
  // boundary is a turn the crash left incomplete. Its journaled spend stays
  // counted; only its messages are discarded and re-driven.
  const messages = [...base, ...turns.flat()];
  let end = messages.length;
  while (end > 0) {
    const role = messageRole(messages[end - 1]);
    if (role === "user" || role === "toolResult") break;
    end -= 1;
  }
  const discardedPartialTurn = end !== messages.length;

  return {
    status: "pending",
    resume: {
      attempts,
      sessionId: started.sessionId,
      input: started.input,
      messages: messages.slice(0, end),
      discardedPartialTurn,
      // Abandoned intents never reached a provider, so they do not consume
      // the resumed run's call ceiling. Unmatched in-flight intents do: they
      // were real attempts.
      priorRootModelCalls: Math.max(0, rootModelIntents - rootAbandoned),
      priorRootCompactions,
      priorToolEvents,
      priorSettled,
      priorTranches,
      priorCalls: settles,
      priorTotals,
      possibleDoubleCountCalls: Math.max(0, intents - settles - abandoned),
    },
  };
}
