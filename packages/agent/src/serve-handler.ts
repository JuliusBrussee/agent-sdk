/** Web-standard agent handler. Node listener and upgrades live in serve.ts. */

import type { TurnEvent } from "@pebble-agent/protocol";
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
import type { AgentDefinition } from "./definition.js";
import { encodeRunEvent, PebbleEventEncoder } from "./pebble-stream.js";
import {
  AgentSessions,
  EventBroadcast,
  eventStreamResponse,
  type SessionRun,
} from "./serve-session.js";
import type { CavemanRunEvent, RunOptions } from "./runtime.js";
import type { AgentServerOptions } from "./serve.js";

export interface AgentHandlerOptions extends Omit<AgentServerOptions, "runOptions"> {
  /** Per-run options; controllers, signals, conversations, and durability are handler-owned. */
  runOptions?: (context: { sessionId: string; runId: string }) =>
    Omit<RunOptions, "durable" | "controller" | "signal" | "conversation">;
  /** Host-owned WebSocket upgrade (Cloudflare WebSocketPair, Deno, Bun, or Node ws wrapper). */
  upgrade?: (request: Request) => { response: Response; socket: WebSocketLike } | undefined;
}

export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message" | "close" | "error", fn: (event: any) => void): void;
}

export interface RecoveryReport {
  readonly listable: boolean;
  readonly resumed: readonly string[];
  readonly sleeping: ReadonlyArray<{ readonly runId: string; readonly wakeAt: string }>;
  readonly skipped: ReadonlyArray<{ readonly runId: string; readonly reason: string }>;
}

export interface AgentHandler {
  fetch(request: Request): Promise<Response>;
  recover(): Promise<RecoveryReport>;
  nextWakeAt(): Promise<Date | undefined>;
  close(graceMs?: number): Promise<void>;
}

interface Job {
  readonly runId: string;
  readonly input: string;
  readonly sessionId: string;
  readonly encoder: PebbleEventEncoder;
  readonly broadcast: EventBroadcast;
  readonly session?: SessionRun;
}

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const SETTLED_RETENTION_MS = 5 * 60_000;
const MAX_RETAINED_BROADCASTS = 256;

function processRoot(): string {
  return typeof process === "undefined" ? "." : process.cwd();
}

function joinPath(root: string, path: string): string {
  return `${root.replace(/[\\/]$/u, "")}/${path}`;
}

/** Length-independent comparison without importing a host crypto module. */
function tokenMatches(presented: string, expected: string): boolean {
  const left = new TextEncoder().encode(presented);
  const right = new TextEncoder().encode(expected);
  let mismatch = left.byteLength ^ right.byteLength;
  const length = Math.max(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index++) mismatch |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return mismatch === 0;
}

function bearer(request: Request): string | undefined {
  const direct = /^Bearer (.+)$/u.exec(request.headers.get("authorization") ?? "")?.[1];
  if (direct !== undefined) return direct;
  const encoded = (request.headers.get("sec-websocket-protocol") ?? "")
    .split(",")
    .map((value) => value.trim())
    .find((value) => value.startsWith("cave-bearer."))
    ?.slice("cave-bearer.".length);
  if (encoded === undefined || encoded === "") return undefined;
  try {
    const normalized = encoded.replace(/-/gu, "+").replace(/_/gu, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    if (typeof atob === "function") {
      const binary = atob(padded);
      return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
    }
    return Buffer.from(padded, "base64").toString("utf8");
  } catch {
    return undefined;
  }
}

function json(status: number, body: unknown, headers?: Record<string, string>): Response {
  const rendered = JSON.stringify(body);
  return new Response(rendered, {
    status,
    headers: {
      "content-type": "application/json",
      "content-length": String(new TextEncoder().encode(rendered).byteLength),
      ...headers,
    },
  });
}

async function textBody(request: Request, maxBytes: number): Promise<string> {
  const reader = request.body?.getReader();
  if (reader === undefined) return "";
  const decoder = new TextDecoder();
  let rendered = "";
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maxBytes) throw new Error("cave_serve_body_too_large");
    rendered += decoder.decode(next.value, { stream: true });
  }
  return rendered + decoder.decode();
}

export function createAgentHandler(options: AgentHandlerOptions): AgentHandler {
  if (typeof options.token !== "string" || options.token.length < 16) {
    throw new Error(
      "cave_serve_token_required: set a bearer token of at least 16 characters; this endpoint spends money",
    );
  }
  const rootDir = options.rootDir ?? processRoot();
  const store = options.store ?? new DiskDurableStore(joinPath(rootDir, ".caveman/runs/durable"));
  const maxConcurrentRuns = options.maxConcurrentRuns ?? 2;
  const maxQueuedRuns = options.maxQueuedRuns ?? 64;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(maxConcurrentRuns) || maxConcurrentRuns < 1) {
    throw new Error("cave_serve_concurrency_invalid");
  }

  const queue: Job[] = [];
  const active = new Map<string, Promise<void>>();
  const cancellers = new Map<string, AbortController>();
  const broadcasts = new Map<string, EventBroadcast>();
  let ready = false;
  let draining = false;
  let sweeping = false;

  function admitted(runId: string): boolean {
    return active.has(runId) || queue.some((job) => job.runId === runId);
  }

  function evictRetainedBroadcasts(): void {
    const now = Date.now();
    const settled: Array<[string, EventBroadcast]> = [];
    for (const entry of broadcasts) {
      if (!entry[1].settled) continue;
      if (now - entry[1].settledAt >= SETTLED_RETENTION_MS) {
        broadcasts.delete(entry[0]);
        continue;
      }
      settled.push(entry);
    }
    settled.sort((left, right) => left[1].settledAt - right[1].settledAt);
    while (settled.length > MAX_RETAINED_BROADCASTS) {
      const oldest = settled.shift();
      if (oldest !== undefined) broadcasts.delete(oldest[0]);
    }
  }

  function enqueue(job: Job): void {
    queue.push(job);
    pump();
  }

  function enqueueLegacy(runId: string, input: string): void {
    const broadcast = new EventBroadcast();
    broadcasts.set(runId, broadcast);
    evictRetainedBroadcasts();
    enqueue({ runId, input, sessionId: runId, encoder: new PebbleEventEncoder(runId), broadcast });
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
    const factoryOptions = options.runOptions?.({ sessionId: job.sessionId, runId: job.runId }) ?? {};
    const runOptions: RunOptions = {
      ...factoryOptions,
      rootDir: factoryOptions.rootDir ?? rootDir,
      durable: { runId: job.runId, store },
      signal: canceller.signal,
      ...(job.session === undefined
        ? {}
        : {
          sessionId: job.session.sessionId,
          conversation: job.session.conversation,
          controller: job.session.controller,
        }),
    };
    let closedTurn = false;
    const emit = (event: CavemanRunEvent): void => {
      for (const encoded of encodeRunEvent(job.encoder, event)) {
        job.broadcast.push(encoded);
        if (encoded.kind === "turn.end") closedTurn = true;
      }
    };
    const closeTurn = (message: string): void => {
      if (closedTurn) return;
      closedTurn = true;
      job.broadcast.push(job.encoder.event({ kind: "error", message, retryable: false }));
      job.broadcast.push(job.encoder.event({ kind: "turn.end", stopReason: "error" }));
    };
    try {
      const pendingCancel = await durableCancelRequest(store, job.runId);
      if (pendingCancel !== undefined) {
        cancellers.delete(job.runId);
        await settleCancelledRun(store, job.runId, pendingCancel);
        closeTurn(DURABLE_CANCELLED_CODE);
        return;
      }
      job.broadcast.push(job.encoder.event({ kind: "turn.start" }));
      const runtime = await import("./runtime.js");
      const events = options.build === undefined
        ? runtime.streamAgent(options.definition, job.input, runOptions)
        : runtime.streamLockedAgent(options.definition, job.input, options.build, runOptions);
      for await (const event of events) emit(event);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (typeof process !== "undefined") {
        process.stderr.write(`caveman-agent serve: run ${job.runId} failed: ${message}\n`);
      }
      closeTurn(message);
    } finally {
      closeTurn("cave_serve_run_ended_without_terminal_event");
      if (job.session === undefined) job.broadcast.settle();
      cancellers.delete(job.runId);
      active.delete(job.runId);
      const cancelled = await durableCancelRequest(store, job.runId).catch(() => undefined);
      if (cancelled !== undefined) {
        await settleCancelledRun(store, job.runId, cancelled).catch(() => undefined);
      }
      job.session?.onSettled();
      pump();
    }
  }

  async function summarize(runId: string): Promise<DurableRunSummary> {
    return durableRunSummary(await store.load(runId));
  }

  async function cancelSessionRun(runId: string): Promise<void> {
    const queued = queue.findIndex((job) => job.runId === runId);
    if (queued !== -1) {
      const [removed] = queue.splice(queued, 1);
      removed?.session?.onSettled();
      return;
    }
    const outcome = await requestDurableCancel(store, runId);
    if (outcome.status === "requested") cancellers.get(runId)?.abort();
  }

  const sessions = new AgentSessions(store, {
    start(session): void {
      enqueue({
        runId: session.runId,
        input: session.input,
        sessionId: session.sessionId,
        encoder: session.encoder,
        broadcast: session.broadcast,
        session,
      });
    },
    cancel: cancelSessionRun,
    summary: summarize,
  }, maxBodyBytes);

  async function sweep(
    resumed: string[],
    skipped: Array<{ runId: string; reason: string }>,
    sleeping: Array<{ runId: string; wakeAt: string }>,
    claimed: ReadonlySet<string>,
  ): Promise<RecoveryReport> {
    if (store.list === undefined) return { listable: false, resumed, skipped, sleeping };
    for (const runId of await store.list()) {
      if (claimed.has(runId) || admitted(runId)) continue;
      let summary: DurableRunSummary;
      try { summary = await summarize(runId); }
      catch (error) {
        skipped.push({ runId, reason: error instanceof Error ? error.message : String(error) });
        continue;
      }
      if (summary.status !== "pending") continue;
      if (summary.cancelRequested !== undefined) {
        await settleCancelledRun(store, runId, summary.cancelRequested);
        skipped.push({ runId, reason: DURABLE_CANCELLED_CODE });
        continue;
      }
      if (!durableRunIsDue(summary)) {
        sleeping.push({ runId, wakeAt: summary.wakeAt ?? "" });
        continue;
      }
      if (!durableInputIsReplayable(summary.input)) {
        skipped.push({ runId, reason: "cave_serve_resume_needs_original_input" });
        continue;
      }
      enqueueLegacy(runId, summary.input);
      resumed.push(runId);
    }
    return { listable: true, resumed, skipped, sleeping };
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
      const sessionRecovery = await sessions.recover();
      resumed.push(...sessionRecovery.resumed);
      return await sweep(resumed, skipped, sleeping, sessionRecovery.claimed);
    } finally {
      sweeping = false;
      ready = true;
    }
  }

  async function submit(request: Request): Promise<Response> {
    if (draining) return json(503, { error: "cave_serve_draining" }, { "retry-after": "5" });
    let body: string;
    try { body = await textBody(request, maxBodyBytes); }
    catch (error) {
      return json(413, { error: error instanceof Error ? error.message : "cave_serve_body_too_large" });
    }
    let payload: unknown;
    try { payload = JSON.parse(body); }
    catch { return json(400, { error: "cave_serve_body_invalid_json" }); }
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      return json(400, { error: "cave_serve_body_invalid" });
    }
    const { runId: rawRunId, input } = payload as { runId?: unknown; input?: unknown };
    if (typeof rawRunId !== "string") return json(400, { error: "cave_serve_run_id_required" });
    try { validateDurableRunId(rawRunId); }
    catch (error) {
      return json(400, {
        error: "cave_durable_run_id_invalid",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    if (typeof input !== "string" || input === "") {
      return json(400, { error: "cave_serve_input_must_be_text" });
    }
    const summary = await summarize(rawRunId);
    if (summary.status === "completed" || summary.status === "failed") return json(200, summary);
    if (admitted(rawRunId)) return json(202, { runId: rawRunId, status: "running" });
    if (summary.status === "pending" && !durableRunIsDue(summary)) {
      return json(202, { runId: rawRunId, status: "sleeping", wakeAt: summary.wakeAt });
    }
    if (queue.length >= maxQueuedRuns) {
      return json(503, { error: "cave_serve_queue_full" }, { "retry-after": "5" });
    }
    enqueueLegacy(rawRunId, input);
    return json(202, {
      runId: rawRunId,
      status: summary.status === "pending" ? "resuming" : "running",
    });
  }

  async function legacyEvents(rawRunId: string, request: Request): Promise<Response> {
    let runId: string;
    try { runId = decodeURIComponent(rawRunId); validateDurableRunId(runId); }
    catch { return json(400, { error: "cave_durable_run_id_invalid" }); }
    const broadcast = broadcasts.get(runId);
    if (broadcast === undefined) {
      const summary = await summarize(runId);
      return json(summary.status === "missing" ? 404 : 409, {
        error: summary.status === "missing" ? "cave_serve_not_found" : "cave_serve_events_not_retained",
        message: summary.status === "missing"
          ? undefined
          : "events are held in memory for a limited window; read GET /runs/:id for the outcome",
        status: summary.status,
      });
    }
    return eventStreamResponse(broadcast, request, true);
  }

  async function fetchHandler(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/healthz") return json(200, { status: "ok" });
    if (path === "/readyz") {
      return json(ready ? 200 : 503, {
        status: ready ? "ready" : "recovering",
        active: active.size,
        queued: queue.length,
      });
    }
    const presented = bearer(request);
    if (presented === undefined || !tokenMatches(presented, options.token)) {
      return json(401, { error: "cave_serve_unauthorized" });
    }
    const wsMatch = /^\/sessions\/([^/]+)\/ws$/.exec(path);
    if (wsMatch?.[1] !== undefined && request.method === "GET") {
      const rejected = await sessions.webSocketPreflight(wsMatch[1]);
      if (rejected !== undefined) return rejected;
      const upgraded = options.upgrade?.(request);
      if (upgraded === undefined) return json(501, { error: "cave_serve_websocket_unavailable" });
      const attached = await sessions.webSocket(wsMatch[1], request, upgraded.socket);
      if (!attached.ok) {
        upgraded.socket.close(1008, (await attached.json() as { error?: string }).error ?? "rejected");
      }
      return upgraded.response;
    }
    const sessionResponse = await sessions.route(request, path);
    if (sessionResponse !== undefined) return sessionResponse;
    if (path === "/runs" && request.method === "POST") return submit(request);
    const streamMatch = /^\/runs\/([^/]+)\/events$/.exec(path);
    if (streamMatch?.[1] !== undefined && request.method === "GET") {
      return legacyEvents(streamMatch[1], request);
    }
    const match = /^\/runs\/([^/]+)$/.exec(path);
    if (match?.[1] !== undefined && request.method === "DELETE") {
      let runId: string;
      try { runId = decodeURIComponent(match[1]); validateDurableRunId(runId); }
      catch { return json(400, { error: "cave_durable_run_id_invalid" }); }
      const outcome = await requestDurableCancel(store, runId);
      if (outcome.status === "requested") cancellers.get(runId)?.abort();
      return json(outcome.status === "missing" ? 404 : outcome.status === "already_settled" ? 409 : 202, outcome);
    }
    if (match?.[1] !== undefined && request.method === "GET") {
      let runId: string;
      try { runId = decodeURIComponent(match[1]); validateDurableRunId(runId); }
      catch { return json(400, { error: "cave_durable_run_id_invalid" }); }
      const summary = await summarize(runId);
      return json(summary.status === "missing" ? 404 : 200, {
        ...summary,
        ...(summary.status === "pending" ? { driving: active.has(runId) } : {}),
      });
    }
    return json(404, { error: "cave_serve_not_found" });
  }

  return {
    fetch: fetchHandler,
    recover,
    nextWakeAt: () => nextDurableWake(store),
    async close(graceMs = 30_000): Promise<void> {
      draining = true;
      const deadline = Date.now() + graceMs;
      while (active.size > 0 && Date.now() < deadline) {
        await Promise.race([
          Promise.allSettled([...active.values()]),
          new Promise((wake) => setTimeout(wake, 250)),
        ]);
      }
      sessions.close();
    },
  };
}
