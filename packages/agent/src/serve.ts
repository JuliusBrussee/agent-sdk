/**
 * The deployable target: one agent definition behind a small HTTP surface,
 * with every run journaled through `src/durable.ts`.
 *
 * The reliability contract is the journal's, not this file's. This server
 * only supplies the three things a hosting platform needs on top of it:
 *
 * 1. **An idempotent submit.** `POST /runs` is keyed by caller-assigned
 *    `runId`, which is already the durable idempotency key — resubmitting a
 *    settled run replays its journaled outcome and spends nothing.
 * 2. **Recovery on boot.** A container that dies mid-run leaves a journal
 *    with no terminal event. On start the server enumerates the store and
 *    re-drives exactly those, so a restart continues runs instead of
 *    stranding them. A store that cannot enumerate (`list` absent) reports
 *    `listable: false` rather than an empty, falsely reassuring sweep.
 * 3. **A drain on shutdown.** SIGTERM stops intake and lets in-flight runs
 *    settle. Whatever does not finish inside the grace period is still
 *    journaled, so the next instance resumes it — the drain is an
 *    optimization, never the correctness boundary.
 *
 * What this file deliberately does not do: no scheduler, no fan-out, no
 * cross-run orchestration, no queue that outlives the process. The journal
 * is the state, the platform is the supervisor.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import type { TurnEvent } from "@pebble-agent/protocol";
import type { AgentDefinition, RunOptions } from "./index.js";
import { streamAgent, streamLockedAgent, type CavemanRunEvent } from "./runtime.js";
import { encodeRunEvent, PebbleEventEncoder } from "./pebble-stream.js";
import type { AnyCaveBuildLock } from "./build.js";
import {
  DURABLE_CANCELLED_CODE,
  durableCancelRequest,
  durableRunIsDue,
  nextDurableWake,
  requestDurableCancel,
  settleCancelledRun,
} from "./durable-control.js";
import {
  DiskDurableStore,
  durableInputIsReplayable,
  durableRunSummary,
  validateDurableRunId,
  type DurableRunSummary,
  type DurableStore,
} from "./durable.js";

export interface AgentServerOptions {
  /** The agent every run on this server executes. */
  definition: AgentDefinition;
  /**
   * Bearer token required on `/runs`. No default and no unauthenticated
   * mode: this endpoint spends money and returns model output.
   */
  token: string;
  /** Journal storage. Defaults to disk under `<rootDir>/.caveman/runs/durable`. */
  store?: DurableStore;
  /** Working root for the agent and the default store. Defaults to `process.cwd()`. */
  rootDir?: string;
  /** When present every run executes through the frozen build instead of `run()`. */
  build?: AnyCaveBuildLock;
  /** Run defaults. `durable` is owned by the server and cannot be supplied. */
  runOptions?: Omit<RunOptions, "durable">;
  /** Runs driven at once. Default 2 — model calls are the bottleneck, not CPU. */
  maxConcurrentRuns?: number;
  /** Accepted-but-not-started ceiling before `POST /runs` sheds load. Default 64. */
  maxQueuedRuns?: number;
  /** Request body ceiling. Default 1 MiB. */
  maxBodyBytes?: number;
}

export interface RecoveryReport {
  /** False when the store cannot enumerate runs, so no sweep was possible. */
  readonly listable: boolean;
  /** Pending runs re-queued from their journals. */
  readonly resumed: readonly string[];
  /**
   * Pending runs deliberately left alone because their durable sleep has not
   * elapsed. Separate from `skipped`: these are healthy runs waiting on a
   * clock, not runs this server could not drive.
   */
  readonly sleeping: ReadonlyArray<{ readonly runId: string; readonly wakeAt: string }>;
  /** Pending runs this server refused to auto-resume, each with its reason. */
  readonly skipped: ReadonlyArray<{ readonly runId: string; readonly reason: string }>;
}

export interface AgentServer {
  /** The underlying server, for callers that own their own listen/upgrade wiring. */
  readonly server: Server;
  /** Bind and start accepting. Resolves with the bound port. */
  listen(port: number, host?: string): Promise<number>;
  /**
   * Re-drive every pending journal. Called once by `listen`; `/readyz` stays
   * 503 until it resolves, so a platform does not route traffic to an
   * instance that has not yet reclaimed its own crashed work.
   */
  recover(): Promise<RecoveryReport>;
  /**
   * Earliest instant any journaled run becomes due, or undefined when nothing
   * is sleeping (or the store cannot enumerate, which is unknown, not empty).
   *
   * This is the scale-to-zero hook: a platform can shut the instance down and
   * bring one back at exactly this time instead of paying for a process that
   * only watches a clock.
   */
  nextWakeAt(): Promise<Date | undefined>;
  /** Stop intake, let in-flight runs settle for `graceMs`, then close. */
  close(graceMs?: number): Promise<void>;
}

interface Job {
  readonly runId: string;
  readonly input: string;
}

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
/** How often a running instance re-checks the store for stranded runs. */
const RECOVERY_SWEEP_INTERVAL_MS = 60_000;

/** Length-independent bearer comparison. */
function tokenMatches(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/**
 * Per-run event log with live fan-out, for `GET /runs/:id/events`.
 *
 * The journal is the durability boundary; this is not. It holds a bounded
 * window of the Pebble events a run has emitted IN THIS PROCESS so a client
 * that connects late, or reconnects with `Last-Event-ID`, can catch up without
 * the server replaying model calls. Two consequences are deliberate and
 * reported rather than hidden:
 *
 * - A run resumed after a crash starts a fresh sequence. Events emitted by the
 *   instance that died are gone; only the journal survives a restart.
 * - Past {@link MAX_BUFFERED_EVENTS} the oldest events are evicted, and a
 *   client asking for one of them is told so with a `gap` frame instead of
 *   being silently handed a transcript with a hole in it.
 */
class RunBroadcast {
  private readonly buffered: TurnEvent[] = [];
  /** Sequence of the oldest event still buffered. Rises as events are evicted. */
  private floor = 0;
  private readonly listeners = new Set<(event: TurnEvent) => void>();
  settled = false;
  settledAt = 0;

  push(event: TurnEvent): void {
    this.buffered.push(event);
    while (this.buffered.length > MAX_BUFFERED_EVENTS) {
      this.buffered.shift();
      this.floor += 1;
    }
    for (const listener of this.listeners) listener(event);
  }

  /**
   * Events at or after `seq`. `gap` is true when `seq` names an event already
   * evicted, so the caller must surface the discontinuity rather than resume.
   */
  since(seq: number): { readonly events: readonly TurnEvent[]; readonly gap: boolean } {
    if (seq < this.floor) return { events: [...this.buffered], gap: true };
    return { events: this.buffered.slice(seq - this.floor), gap: false };
  }

  get earliest(): number {
    return this.floor;
  }

  subscribe(listener: (event: TurnEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.settled = true;
    this.settledAt = Date.now();
    this.listeners.clear();
  }
}

/** Buffered events per run before the oldest are evicted. */
const MAX_BUFFERED_EVENTS = 2048;
/** How long a settled run's events stay replayable after it finishes. */
const SETTLED_RETENTION_MS = 5 * 60_000;
/** Settled runs whose buffers are retained at once. */
const MAX_RETAINED_BROADCASTS = 256;
/** Idle gap before a comment frame is sent to keep intermediaries from closing. */
const SSE_HEARTBEAT_MS = 15_000;
/**
 * Unflushed bytes tolerated for one subscriber. A client that cannot keep up is
 * disconnected rather than allowed to grow the server's heap; it reconnects
 * with `Last-Event-ID` and resumes from the buffer.
 */
const SSE_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

export function createAgentServer(options: AgentServerOptions): AgentServer {
  if (typeof options.token !== "string" || options.token.length < 16) {
    throw new Error(
      "cave_serve_token_required: set a bearer token of at least 16 characters; this endpoint spends money",
    );
  }
  if (options.runOptions !== undefined &&
      (options.runOptions as RunOptions).durable !== undefined) {
    throw new Error("cave_serve_durable_owned: the server assigns durable options per request");
  }
  const rootDir = resolve(options.rootDir ?? process.cwd());
  const store = options.store ??
    new DiskDurableStore(resolve(rootDir, ".caveman", "runs", "durable"));
  const maxConcurrentRuns = options.maxConcurrentRuns ?? 2;
  const maxQueuedRuns = options.maxQueuedRuns ?? 64;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(maxConcurrentRuns) || maxConcurrentRuns < 1) {
    throw new Error("cave_serve_concurrency_invalid");
  }

  const queue: Job[] = [];
  const active = new Map<string, Promise<void>>();
  /**
   * One controller per run this instance is driving, so a `DELETE /runs/{id}`
   * that lands here stops the run now rather than at the next sweep. The
   * journal is still the durable record — this map only shortens the latency
   * for the common case where the cancel reaches the instance doing the work.
   */
  const cancellers = new Map<string, AbortController>();
  const broadcasts = new Map<string, RunBroadcast>();
  let ready = false;
  let draining = false;
  let sweeping = false;
  let sweepTimer: NodeJS.Timeout | undefined;

  function admitted(runId: string): boolean {
    return active.has(runId) || queue.some((job) => job.runId === runId);
  }

  function enqueue(job: Job): void {
    queue.push(job);
    // Created at admission, not at first subscribe: a client that opens the
    // event stream after POST /runs has already returned must still see the
    // events emitted in between.
    broadcasts.set(job.runId, new RunBroadcast());
    evictRetainedBroadcasts();
    pump();
  }

  /** Drop settled buffers past their retention window, oldest first. */
  function evictRetainedBroadcasts(): void {
    const now = Date.now();
    const settled: Array<[string, RunBroadcast]> = [];
    for (const entry of broadcasts) {
      if (!entry[1].settled) continue;
      if (now - entry[1].settledAt >= SETTLED_RETENTION_MS) {
        broadcasts.delete(entry[0]);
        continue;
      }
      settled.push(entry);
    }
    settled.sort((a, b) => a[1].settledAt - b[1].settledAt);
    while (settled.length > MAX_RETAINED_BROADCASTS) {
      const oldest = settled.shift();
      if (oldest !== undefined) broadcasts.delete(oldest[0]);
    }
  }

  function pump(): void {
    while (!draining && active.size < maxConcurrentRuns && queue.length > 0) {
      const job = queue.shift();
      if (job === undefined) return;
      active.set(job.runId, drive(job));
    }
  }

  async function drive(job: Job): Promise<void> {
    const canceller = new AbortController();
    cancellers.set(job.runId, canceller);
    const runOptions: RunOptions = {
      ...options.runOptions,
      rootDir: options.runOptions?.rootDir ?? rootDir,
      durable: { runId: job.runId, store },
      signal: canceller.signal,
    };
    const broadcast = broadcasts.get(job.runId);
    // The run id is the session identity on the wire: a client reconnecting to
    // the same run sees the same `sessionId` on every event.
    const encoder = new PebbleEventEncoder(job.runId);
    let closedTurn = false;
    const emit = (event: CavemanRunEvent): void => {
      if (broadcast === undefined) return;
      for (const encoded of encodeRunEvent(encoder, event)) {
        broadcast.push(encoded);
        if (encoded.kind === "turn.end") closedTurn = true;
      }
    };
    /**
     * Every subscriber is waiting on a `turn.end` to know the turn is over. A
     * path that reaches here without emitting one would leave them waiting on
     * an event that is never coming, so end the turn explicitly rather than
     * hand out a stream that only a socket timeout can close.
     */
    const closeTurn = (message: string): void => {
      if (broadcast === undefined || closedTurn) return;
      closedTurn = true;
      broadcast.push(encoder.event({ kind: "error", message, retryable: false }));
      broadcast.push(encoder.event({ kind: "turn.end", stopReason: "error" }));
    };
    try {
      // A run can be cancelled between admission and its turn at the front of
      // the queue. Settle it here rather than spending a provider call on work
      // that is already known to be unwanted.
      const pendingCancel = await durableCancelRequest(store, job.runId);
      if (pendingCancel !== undefined) {
        cancellers.delete(job.runId);
        await settleCancelledRun(store, job.runId, pendingCancel);
        closeTurn(DURABLE_CANCELLED_CODE);
        return;
      }
      broadcast?.push(encoder.event({ kind: "turn.start" }));
      const events = options.build === undefined
        ? streamAgent(options.definition, job.input, runOptions)
        : streamLockedAgent(options.definition, job.input, options.build, runOptions);
      for await (const event of events) emit(event);
    } catch (error) {
      // A run that fails after spending is journaled as `run_failed` by the
      // runtime; a failure BEFORE the journal exists (a bad definition, an
      // unavailable store) has nowhere to be recorded but here.
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`caveman-agent serve: run ${job.runId} failed: ${message}\n`);
      closeTurn(message);
    } finally {
      // Covers the quieter failure too: a stream that simply stops without
      // ever yielding run_end or run_error and without throwing.
      closeTurn("cave_serve_run_ended_without_terminal_event");
      broadcast?.close();
      cancellers.delete(job.runId);
      active.delete(job.runId);
      // An abort leaves the journal PENDING, which is correct — an aborted run
      // is resumable by design. A cancelled one must not be: settle it so the
      // next sweep closes it out instead of re-driving it.
      const cancelled = await durableCancelRequest(store, job.runId).catch(() => undefined);
      if (cancelled !== undefined) {
        await settleCancelledRun(store, job.runId, cancelled).catch(() => undefined);
      }
      pump();
    }
  }

  async function summarize(runId: string): Promise<DurableRunSummary> {
    return durableRunSummary(await store.load(runId));
  }

  async function recover(): Promise<RecoveryReport> {
    const resumed: string[] = [];
    const skipped: Array<{ runId: string; reason: string }> = [];
    const sleeping: Array<{ runId: string; wakeAt: string }> = [];
    if (store.list === undefined || sweeping || draining) {
      ready = true;
      return { listable: store.list !== undefined, resumed, skipped, sleeping };
    }
    sweeping = true;
    try {
      return await sweep(resumed, skipped, sleeping);
    } finally {
      sweeping = false;
      ready = true;
    }
  }

  /**
   * One pass over the store. Repeated on an interval, not just at boot,
   * because a run stranded by a PEER instance's death is only reclaimed once
   * somebody looks again — its journal lock is released by the peer's demise,
   * but nothing re-drives it until a sweep notices.
   *
   * ponytail: O(journals) per sweep, and every sweep reads each journal.
   * Fine to thousands of runs; past that the store wants a pending index
   * (a `list({ status: "pending" })` the DO/SQL store can answer directly).
   */
  async function sweep(
    resumed: string[],
    skipped: Array<{ runId: string; reason: string }>,
    sleeping: Array<{ runId: string; wakeAt: string }>,
  ): Promise<RecoveryReport> {
    if (store.list === undefined) return { listable: false, resumed, skipped, sleeping };
    for (const runId of await store.list()) {
      if (admitted(runId)) continue;
      let summary: DurableRunSummary;
      try {
        summary = await summarize(runId);
      } catch (error) {
        // A corrupt or future-version journal is not something to drive.
        skipped.push({
          runId,
          reason: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      if (summary.status !== "pending") continue;
      if (summary.cancelRequested !== undefined) {
        // Requested while nobody was driving it. Close it out where it stopped:
        // no provider call, no spend, and never resumed.
        await settleCancelledRun(store, runId, summary.cancelRequested);
        skipped.push({ runId, reason: DURABLE_CANCELLED_CODE });
        continue;
      }
      if (!durableRunIsDue(summary)) {
        // Sleeping, not stranded. Driving it now would burn the wait the run
        // asked for — and the money it was avoiding.
        sleeping.push({ runId, wakeAt: summary.wakeAt ?? "" });
        continue;
      }
      if (!durableInputIsReplayable(summary.input)) {
        // Multimodal input is journaled as a digest, not content: the run is
        // resumable, but only by a caller who still holds the original input.
        skipped.push({ runId, reason: "cave_serve_resume_needs_original_input" });
        continue;
      }
      enqueue({ runId, input: summary.input });
      resumed.push(runId);
    }
    return { listable: true, resumed, skipped, sleeping };
  }

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      send(response, 500, {
        error: "cave_serve_internal",
        message: error instanceof Error ? error.message : String(error),
      });
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = url.pathname;
    if (path === "/healthz") {
      // Liveness only: the process is up. Unauthenticated on purpose, so a
      // platform health check needs no credential, and it reveals nothing.
      send(response, 200, { status: "ok" });
      return;
    }
    if (path === "/readyz") {
      send(response, ready ? 200 : 503, {
        status: ready ? "ready" : "recovering",
        active: active.size,
        queued: queue.length,
      });
      return;
    }
    const presented = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1];
    if (presented === undefined || !tokenMatches(presented, options.token)) {
      send(response, 401, { error: "cave_serve_unauthorized" });
      return;
    }
    if (path === "/runs" && request.method === "POST") {
      await submit(request, response);
      return;
    }
    const streamMatch = /^\/runs\/([^/]+)\/events$/.exec(path);
    if (streamMatch?.[1] !== undefined && request.method === "GET") {
      await streamEvents(streamMatch[1], request, response);
      return;
    }
    const match = /^\/runs\/([^/]+)$/.exec(path);
    if (match?.[1] !== undefined && request.method === "DELETE") {
      // Reached only past the bearer check above: cancelling a run is a
      // privileged operation on the same resource that spends money.
      let runId: string;
      try {
        runId = decodeURIComponent(match[1]);
        validateDurableRunId(runId);
      } catch {
        send(response, 400, { error: "cave_durable_run_id_invalid" });
        return;
      }
      const outcome = await requestDurableCancel(store, runId);
      // Stop the local driver immediately when this is the instance running it;
      // the journal entry is what makes the request survive everything else.
      if (outcome.status === "requested") cancellers.get(runId)?.abort();
      send(
        response,
        outcome.status === "missing" ? 404 : outcome.status === "already_settled" ? 409 : 202,
        outcome,
      );
      return;
    }
    if (match?.[1] !== undefined && request.method === "GET") {
      let runId: string;
      try {
        runId = decodeURIComponent(match[1]);
        validateDurableRunId(runId);
      } catch {
        send(response, 400, { error: "cave_durable_run_id_invalid" });
        return;
      }
      const summary = await summarize(runId);
      send(response, summary.status === "missing" ? 404 : 200, {
        ...summary,
        ...(summary.status === "pending" ? { driving: active.has(runId) } : {}),
      });
      return;
    }
    send(response, 404, { error: "cave_serve_not_found" });
  }

  /**
   * Live Pebble v1 events for one run, as Server-Sent Events.
   *
   * `id:` carries the event's protocol `seq`, so a dropped connection resumes
   * from `Last-Event-ID` with no duplicates and no silent holes: a request for
   * an evicted sequence gets a `gap` frame naming the earliest event still
   * held, and the client decides what to do about the missing span.
   *
   * This endpoint reports a run's events, never its authority. The journal
   * behind `GET /runs/:id` remains the record of what happened.
   */
  async function streamEvents(
    rawRunId: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    let runId: string;
    try {
      runId = decodeURIComponent(rawRunId);
      validateDurableRunId(runId);
    } catch {
      send(response, 400, { error: "cave_durable_run_id_invalid" });
      return;
    }
    const broadcast = broadcasts.get(runId);
    if (broadcast === undefined) {
      // Either the run never existed here, or it settled long enough ago that
      // its events were released. Both are answerable from the journal, and
      // neither is an event stream, so say which rather than hang an empty one.
      const summary = await summarize(runId);
      send(response, summary.status === "missing" ? 404 : 409, {
        error: summary.status === "missing"
          ? "cave_serve_not_found"
          : "cave_serve_events_not_retained",
        message: summary.status === "missing"
          ? undefined
          : "events are held in memory for a limited window; read GET /runs/:id for the outcome",
        status: summary.status,
      });
      return;
    }

    const resumeFrom = Number.parseInt(
      (request.headers["last-event-id"] as string | undefined) ??
        new URL(request.url ?? "/", "http://localhost").searchParams.get("lastEventId") ??
        "",
      10,
    );
    // `Last-Event-ID` names the last event the client SAW, so resume after it.
    const from = Number.isSafeInteger(resumeFrom) && resumeFrom >= 0 ? resumeFrom + 1 : 0;

    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Nothing here is cacheable or shareable across callers.
      "x-accel-buffering": "no",
    });

    let closed = false;
    const finish = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      response.end();
    };

    const write = (frame: string): void => {
      if (closed) return;
      response.write(frame);
      if (response.writableLength > SSE_MAX_BUFFERED_BYTES) {
        // Too slow to keep up. Dropping the connection bounds the heap; the
        // client reconnects with Last-Event-ID and loses nothing still buffered.
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        response.destroy();
      }
    };

    // Highest sequence already sent. An event can reach both the replay
    // snapshot and the live listener if it lands between subscribing and
    // reading the buffer; the watermark makes writing it twice impossible.
    let lastWritten = from - 1;
    const writeEvent = (event: TurnEvent): void => {
      if (event.seq <= lastWritten) return;
      lastWritten = event.seq;
      write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
      if (event.kind === "turn.end") finish();
    };

    const pending: TurnEvent[] = [];
    let replaying = true;
    const unsubscribe = broadcast.subscribe((event) => {
      // Events arriving mid-replay are held so the client never sees a later
      // sequence before an earlier one.
      if (replaying) pending.push(event);
      else writeEvent(event);
    });
    const heartbeat = setInterval(() => { write(": keepalive\n\n"); }, SSE_HEARTBEAT_MS);
    heartbeat.unref?.();
    request.on("close", finish);

    const replay = broadcast.since(from);
    if (replay.gap) {
      write(`event: gap\ndata: ${JSON.stringify({
        error: "cave_serve_events_gap",
        requestedSeq: from,
        earliestSeq: broadcast.earliest,
      })}\n\n`);
    }
    for (const event of replay.events) writeEvent(event);
    replaying = false;
    for (const event of pending) writeEvent(event);
    // A run that settled before this client attached has already emitted its
    // turn.end during replay, which closed the stream.
    if (broadcast.settled) finish();
  }

  async function submit(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (draining) {
      response.setHeader("retry-after", "5");
      send(response, 503, { error: "cave_serve_draining" });
      return;
    }
    let body: string;
    try {
      body = await readBody(request, maxBodyBytes);
    } catch (error) {
      send(response, 413, {
        error: error instanceof Error ? error.message : "cave_serve_body_too_large",
      });
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      send(response, 400, { error: "cave_serve_body_invalid_json" });
      return;
    }
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      send(response, 400, { error: "cave_serve_body_invalid" });
      return;
    }
    const { runId, input } = payload as { runId?: unknown; input?: unknown };
    if (typeof runId !== "string") {
      send(response, 400, { error: "cave_serve_run_id_required" });
      return;
    }
    try {
      validateDurableRunId(runId);
    } catch (error) {
      send(response, 400, {
        error: "cave_durable_run_id_invalid",
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (typeof input !== "string" || input === "") {
      // Text input only: multimodal input journals a digest, which no
      // unattended resume could reconstruct. Fail closed rather than accept a
      // run this server could not recover.
      send(response, 400, { error: "cave_serve_input_must_be_text" });
      return;
    }

    // Idempotency: the journal decides, not this process's memory. A settled
    // run answers with its journaled outcome and starts nothing.
    const summary = await summarize(runId);
    if (summary.status === "completed" || summary.status === "failed") {
      send(response, 200, summary);
      return;
    }
    if (admitted(runId)) {
      send(response, 202, { runId, status: "running" });
      return;
    }
    if (summary.status === "pending" && !durableRunIsDue(summary)) {
      // Resubmitting a sleeping run must not wake it early. The wake time is
      // the run's own decision and the reason it is costing nothing right now.
      send(response, 202, { runId, status: "sleeping", wakeAt: summary.wakeAt });
      return;
    }
    if (queue.length >= maxQueuedRuns) {
      response.setHeader("retry-after", "5");
      send(response, 503, { error: "cave_serve_queue_full" });
      return;
    }
    enqueue({ runId, input });
    send(response, 202, { runId, status: summary.status === "pending" ? "resuming" : "running" });
  }

  return {
    server,
    nextWakeAt: () => nextDurableWake(store),
    async listen(port: number, host = "0.0.0.0"): Promise<number> {
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once("error", rejectListen);
        server.listen(port, host, () => {
          server.removeListener("error", rejectListen);
          resolveListen();
        });
      });
      // Recovery runs after bind so the platform's health check can reach an
      // instance that is still reclaiming work; `/readyz` reports the truth.
      await recover();
      // Keep looking. An unref'd timer never holds the process open.
      sweepTimer = setInterval(() => { void recover(); }, RECOVERY_SWEEP_INTERVAL_MS);
      sweepTimer.unref?.();
      const address = server.address();
      return typeof address === "object" && address !== null ? address.port : port;
    },
    recover,
    async close(graceMs = 30_000): Promise<void> {
      draining = true;
      if (sweepTimer !== undefined) clearInterval(sweepTimer);
      const deadline = Date.now() + graceMs;
      await new Promise<void>((resolveClose) => server.close(() => { resolveClose(); }));
      while (active.size > 0 && Date.now() < deadline) {
        await Promise.race([
          Promise.allSettled([...active.values()]),
          new Promise((wake) => setTimeout(wake, 250)),
        ]);
      }
      // Anything still running is journaled; the next instance resumes it.
    },
  };
}

async function readBody(request: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.byteLength;
    if (total > maxBytes) throw new Error("cave_serve_body_too_large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const rendered = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(rendered),
  });
  response.end(rendered);
}
