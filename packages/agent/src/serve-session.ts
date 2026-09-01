import type { TurnEvent } from "@pebble-agent/protocol";
import {
  durableConversationCheckpoint,
  durableRunSummary,
  validateDurableRunId,
  type DurableConversationCheckpoint,
  type DurableRunSummary,
  type DurableStore,
} from "./durable.js";
import type { AgentRunController, Conversation } from "./runtime.js";
import { PebbleEventEncoder } from "./pebble-stream.js";

/** Buffered Pebble frames retained per live run/session stream. */
const MAX_BUFFERED_EVENTS = 2048;
const SSE_HEARTBEAT_MS = 15_000;
const SSE_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

export interface WebSocketPeer {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "message" | "close" | "error",
    fn: (event: { data?: unknown }) => void,
  ): void;
}

/** Process-local replay window. Durable authority remains run journals. */
export class EventBroadcast {
  private readonly buffered: TurnEvent[] = [];
  private readonly listeners = new Set<(event: TurnEvent) => void>();
  private readonly closeListeners = new Set<() => void>();
  private floor = 0;
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

  since(seq: number, gapAhead = false): {
    readonly events: readonly TurnEvent[];
    readonly gap: boolean;
    readonly earliest: number;
  } {
    const next = this.floor + this.buffered.length;
    const gap = seq < this.floor || (gapAhead && seq > next);
    return {
      events: gap ? [...this.buffered] : this.buffered.slice(seq - this.floor),
      gap,
      earliest: this.floor,
    };
  }

  subscribe(listener: (event: TurnEvent) => void, onClose?: () => void): () => void {
    this.listeners.add(listener);
    if (onClose !== undefined) this.closeListeners.add(onClose);
    return () => {
      this.listeners.delete(listener);
      if (onClose !== undefined) this.closeListeners.delete(onClose);
    };
  }

  settle(): void {
    this.settled = true;
    this.settledAt = Date.now();
  }

  close(): void {
    this.settle();
    for (const listener of this.closeListeners) listener();
    this.listeners.clear();
    this.closeListeners.clear();
  }
}

function resumeSequence(request: Request): number {
  const parsed = Number.parseInt(
    request.headers.get("last-event-id") ?? new URL(request.url).searchParams.get("lastEventId") ?? "",
    10,
  );
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed + 1 : 0;
}

function gapFrame(requestedSeq: number, earliestSeq: number): Record<string, unknown> {
  return { error: "cave_serve_events_gap", requestedSeq, earliestSeq };
}

/** Web-standard SSE response with existing replay/gap semantics. */
export function eventStreamResponse(
  broadcast: EventBroadcast,
  request: Request,
  endOnTurnEnd: boolean,
): Response {
  const requested = resumeSequence(request);
  let cleanup = (): void => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      let lastWritten = requested - 1;
      let unsubscribe = (): void => {};
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const close = (): void => {
        if (closed) return;
        closed = true;
        if (heartbeat !== undefined) clearInterval(heartbeat);
        unsubscribe();
        try { controller.close(); } catch { /* already cancelled */ }
      };
      cleanup = close;
      const write = (text: string): void => {
        if (closed) return;
        if ((controller.desiredSize ?? 1) <= 0) { close(); return; }
        try { controller.enqueue(encoder.encode(text)); } catch { close(); }
      };
      const writeEvent = (event: TurnEvent): void => {
        if (event.seq <= lastWritten) return;
        lastWritten = event.seq;
        write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
        if (endOnTurnEnd && event.kind === "turn.end") close();
      };
      const pending: TurnEvent[] = [];
      let replaying = true;
      unsubscribe = broadcast.subscribe((event) => {
        if (replaying) pending.push(event);
        else writeEvent(event);
      }, close);
      heartbeat = setInterval(() => { write(": keepalive\n\n"); }, SSE_HEARTBEAT_MS);
      heartbeat.unref?.();
      request.signal.addEventListener("abort", close, { once: true });
      const replay = broadcast.since(requested, !endOnTurnEnd);
      if (replay.gap) {
        write(`event: gap\ndata: ${JSON.stringify(gapFrame(requested, replay.earliest))}\n\n`);
        lastWritten = replay.earliest - 1;
      }
      for (const event of replay.events) writeEvent(event);
      replaying = false;
      for (const event of pending) writeEvent(event);
      if (endOnTurnEnd && broadcast.settled) close();
    },
    cancel() { cleanup(); },
  }, {
    highWaterMark: SSE_MAX_BUFFERED_BYTES,
    size: (chunk) => chunk.byteLength,
  });
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

export interface SessionRun {
  readonly runId: string;
  readonly input: string;
  readonly sessionId: string;
  readonly conversation: Conversation;
  readonly controller: AgentRunController;
  readonly encoder: PebbleEventEncoder;
  readonly broadcast: EventBroadcast;
  readonly onSettled: () => void;
}

export interface SessionDriver {
  start(run: SessionRun): void;
  cancel(runId: string): Promise<void>;
  summary(runId: string): Promise<DurableRunSummary>;
}

interface SessionMessage {
  readonly runId: string;
  readonly text: string;
  readonly author?: string;
  readonly mode: "followUp" | "steer";
  readonly queued: boolean;
  readonly at: string;
}

interface SessionState {
  readonly sessionId: string;
  readonly checkpoint: DurableConversationCheckpoint;
  readonly encoder: PebbleEventEncoder;
  readonly broadcast: EventBroadcast;
  readonly runs: string[];
  readonly messages: SessionMessage[];
  conversation?: Conversation;
  controller?: AgentRunController;
  nextRun: number;
  active?: string;
  error?: string;
}

function json(status: number, body: unknown): Response {
  const rendered = JSON.stringify(body);
  return new Response(rendered, {
    status,
    headers: {
      "content-type": "application/json",
      "content-length": String(new TextEncoder().encode(rendered).byteLength),
    },
  });
}

async function requestJson(request: Request, maxBytes: number): Promise<unknown> {
  const reader = request.body?.getReader();
  if (reader === undefined) return JSON.parse("");
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maxBytes) throw new Error("cave_serve_body_too_large");
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function sessionRunNumber(sessionId: string, runId: string): number | undefined {
  const prefix = `${sessionId}.`;
  if (!runId.startsWith(prefix)) return undefined;
  const value = Number(runId.slice(prefix.length));
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function validateSessionId(value: unknown): string {
  if (typeof value !== "string" || value === "") throw new Error("cave_session_id_required");
  validateDurableRunId(`${value}.1`);
  return value;
}

function parseEvent(line: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function validatedCheckpoint(
  value: unknown,
  sessionId: string,
): DurableConversationCheckpoint | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.sessionId !== sessionId || !Array.isArray(candidate.messages) ||
      typeof candidate.messagesSha256 !== "string") return undefined;
  try {
    const checkpoint = durableConversationCheckpoint(sessionId, candidate.messages);
    return checkpoint.messagesSha256 === candidate.messagesSha256 ? checkpoint : undefined;
  } catch {
    return undefined;
  }
}

function runCheckpoints(lines: readonly string[], sessionId: string): {
  readonly base?: DurableConversationCheckpoint;
  readonly terminal?: DurableConversationCheckpoint;
} {
  let base: DurableConversationCheckpoint | undefined;
  let terminal: DurableConversationCheckpoint | undefined;
  for (const line of lines) {
    const event = parseEvent(line);
    if (event?.type === "run_started") base = validatedCheckpoint(event.conversation, sessionId);
    if (event?.type === "run_completed") {
      terminal = validatedCheckpoint(event.conversation, sessionId);
    }
  }
  return {
    ...(base === undefined ? {} : { base }),
    ...(terminal === undefined ? {} : { terminal }),
  };
}

function initialSession(sessionId: string, checkpoint?: DurableConversationCheckpoint): SessionState {
  const base = checkpoint ?? durableConversationCheckpoint(sessionId, []);
  return {
    sessionId,
    checkpoint: base,
    encoder: new PebbleEventEncoder(sessionId),
    broadcast: new EventBroadcast(),
    runs: [],
    messages: [],
    nextRun: 1,
  };
}

/** Session lifecycle; Pi owns all active steering/follow-up queue mechanics. */
export class AgentSessions {
  private readonly sessions = new Map<string, SessionState>();
  private readonly deleted = new Set<string>();

  constructor(
    private readonly store: DurableStore,
    private readonly driver: SessionDriver,
    private readonly maxBodyBytes: number,
  ) {}

  async recover(): Promise<{ readonly claimed: ReadonlySet<string>; readonly resumed: readonly string[] }> {
    const claimed = new Set<string>();
    const resumed: string[] = [];
    if (this.store.list === undefined) return { claimed, resumed };
    const groups = new Map<string, Array<{ runId: string; n: number }>>();
    for (const runId of await this.store.list()) {
      const lines = await this.store.load(runId);
      const started = parseEvent(lines[0] ?? "");
      if (started?.type !== "run_started" || typeof started.sessionId !== "string") continue;
      const n = sessionRunNumber(started.sessionId, runId);
      if (n === undefined) continue;
      const rows = groups.get(started.sessionId) ?? [];
      rows.push({ runId, n });
      groups.set(started.sessionId, rows);
      claimed.add(runId);
    }
    for (const [sessionId, rows] of groups) {
      rows.sort((a, b) => a.n - b.n);
      if (this.sessions.has(sessionId)) continue;
      const last = rows.at(-1)!;
      const lines = await this.store.load(last.runId);
      const summary = durableRunSummary(lines);
      const checkpoints = runCheckpoints(lines, sessionId);
      const checkpoint = summary.status === "pending" ? checkpoints.base : checkpoints.terminal;
      const state = checkpoint === undefined
        ? { ...initialSession(sessionId), error: "cave_session_conversation_unrecoverable" }
        : initialSession(sessionId, checkpoint);
      state.runs.push(...rows.map((row) => row.runId));
      state.nextRun = last.n + 1;
      this.sessions.set(sessionId, state);
      if (summary.status === "pending" && checkpoint !== undefined) {
        await this.ensureKernel(state);
        state.active = last.runId;
        resumed.push(last.runId);
        this.driver.start({
          runId: last.runId,
          input: summary.input,
          sessionId,
          conversation: state.conversation!,
          controller: state.controller!,
          encoder: state.encoder,
          broadcast: state.broadcast,
          onSettled: () => { delete state.active; },
        });
      }
    }
    return { claimed, resumed };
  }

  async route(request: Request, path: string): Promise<Response | undefined> {
    if (path === "/sessions" && request.method === "POST") return this.create(request);
    const messages = /^\/sessions\/([^/]+)\/messages$/.exec(path);
    if (messages?.[1] !== undefined && request.method === "POST") {
      return this.message(messages[1], request);
    }
    const events = /^\/sessions\/([^/]+)\/events$/.exec(path);
    if (events?.[1] !== undefined && request.method === "GET") {
      const state = await this.loadDecoded(events[1]);
      return state instanceof Response ? state : eventStreamResponse(state.broadcast, request, false);
    }
    const websocket = /^\/sessions\/([^/]+)\/ws$/.exec(path);
    if (websocket?.[1] !== undefined && request.method === "GET") return undefined;
    const session = /^\/sessions\/([^/]+)$/.exec(path);
    if (session?.[1] !== undefined && request.method === "GET") return this.status(session[1]);
    if (session?.[1] !== undefined && request.method === "DELETE") return this.remove(session[1]);
    return undefined;
  }

  async webSocket(rawId: string, request: Request, socket: WebSocketPeer): Promise<Response> {
    const loaded = await this.loadDecoded(rawId);
    if (loaded instanceof Response) return loaded;
    const state = loaded;
    let closed = false;
    const send = (value: unknown): void => {
      if (closed) return;
      try { socket.send(JSON.stringify(value)); } catch { closed = true; }
    };
    const requested = resumeSequence(request);
    const replay = state.broadcast.since(requested, true);
    if (replay.gap) send(gapFrame(requested, replay.earliest));
    for (const event of replay.events) send(event);
    const unsubscribe = state.broadcast.subscribe(send, () => socket.close(1000, "session closed"));
    const close = (): void => { closed = true; unsubscribe(); };
    socket.addEventListener("close", close);
    socket.addEventListener("error", close);
    socket.addEventListener("message", (event) => {
      void this.socketMessage(state, event.data).catch((error: unknown) => {
        socket.close(1008, error instanceof Error ? error.message : "cave_serve_websocket_message_invalid");
      });
    });
    return new Response(null, { status: 200 });
  }

  async webSocketPreflight(rawId: string): Promise<Response | undefined> {
    const loaded = await this.loadDecoded(rawId);
    return loaded instanceof Response ? loaded : undefined;
  }

  close(): void {
    for (const state of this.sessions.values()) state.broadcast.close();
  }

  private async create(request: Request): Promise<Response> {
    let payload: unknown;
    try { payload = await requestJson(request, this.maxBodyBytes); }
    catch (error) {
      const message = error instanceof Error ? error.message : "cave_serve_body_invalid_json";
      return json(message === "cave_serve_body_too_large" ? 413 : 400, {
        error: message === "cave_serve_body_too_large" ? message : "cave_serve_body_invalid_json",
      });
    }
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      return json(400, { error: "cave_serve_body_invalid" });
    }
    let sessionId: string;
    try { sessionId = validateSessionId((payload as { sessionId?: unknown }).sessionId); }
    catch (error) {
      return json(400, {
        error: error instanceof Error && error.message === "cave_session_id_required"
          ? error.message
          : "cave_durable_run_id_invalid",
      });
    }
    this.deleted.delete(sessionId);
    const existing = await this.load(sessionId);
    if (existing === undefined) this.sessions.set(sessionId, initialSession(sessionId));
    return json(201, { sessionId });
  }

  private async message(rawId: string, request: Request): Promise<Response> {
    const loaded = await this.loadDecoded(rawId);
    if (loaded instanceof Response) return loaded;
    let payload: unknown;
    try { payload = await requestJson(request, this.maxBodyBytes); }
    catch (error) {
      const message = error instanceof Error ? error.message : "cave_serve_body_invalid_json";
      return json(message === "cave_serve_body_too_large" ? 413 : 400, {
        error: message === "cave_serve_body_too_large" ? message : "cave_serve_body_invalid_json",
      });
    }
    return this.acceptMessage(loaded, payload);
  }

  private async acceptMessage(state: SessionState, payload: unknown): Promise<Response> {
    if (state.error !== undefined) return json(409, { error: state.error });
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      return json(400, { error: "cave_serve_body_invalid" });
    }
    const { text, author, mode = "followUp" } = payload as {
      text?: unknown; author?: unknown; mode?: unknown;
    };
    if (typeof text !== "string" || text === "") {
      return json(400, { error: "cave_session_message_text_required" });
    }
    if (author !== undefined && (typeof author !== "string" || author === "")) {
      return json(400, { error: "cave_session_message_author_invalid" });
    }
    if (mode !== "followUp" && mode !== "steer") {
      return json(400, { error: "cave_session_message_mode_invalid" });
    }
    await this.ensureKernel(state);
    const queued = state.active !== undefined;
    const runId = state.active ?? `${state.sessionId}.${state.nextRun++}`;
    state.messages.push({
      runId,
      text,
      ...(author === undefined ? {} : { author }),
      mode,
      queued,
      at: new Date().toISOString(),
    });
    if (queued) {
      if (mode === "steer") state.controller!.steer(text);
      else state.controller!.followUp(text);
    } else {
      state.active = runId;
      state.runs.push(runId);
      this.driver.start({
        runId,
        input: text,
        sessionId: state.sessionId,
        conversation: state.conversation!,
        controller: state.controller!,
        encoder: state.encoder,
        broadcast: state.broadcast,
        onSettled: () => { delete state.active; },
      });
    }
    return json(202, { runId, queued });
  }

  private async status(rawId: string): Promise<Response> {
    const loaded = await this.loadDecoded(rawId);
    if (loaded instanceof Response) return loaded;
    if (loaded.error !== undefined) return json(409, { error: loaded.error });
    const runs = await Promise.all(loaded.runs.map((runId) => this.driver.summary(runId)));
    return json(200, {
      sessionId: loaded.sessionId,
      runs,
      ...(loaded.active === undefined ? {} : { active: loaded.active }),
      queued: loaded.controller?.state.queued ?? 0,
      messages: loaded.messages,
    });
  }

  private async remove(rawId: string): Promise<Response> {
    const loaded = await this.loadDecoded(rawId);
    if (loaded instanceof Response) return loaded;
    loaded.controller?.clear();
    if (loaded.active !== undefined) await this.driver.cancel(loaded.active);
    loaded.broadcast.close();
    this.sessions.delete(loaded.sessionId);
    this.deleted.add(loaded.sessionId);
    return json(202, { sessionId: loaded.sessionId, status: "deleted" });
  }

  private async socketMessage(state: SessionState, raw: unknown): Promise<void> {
    const text = typeof raw === "string"
      ? raw
      : raw instanceof ArrayBuffer
        ? new TextDecoder().decode(raw)
        : ArrayBuffer.isView(raw)
          ? new TextDecoder().decode(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength))
          : String(raw);
    let payload: unknown;
    try { payload = JSON.parse(text); }
    catch { throw new Error("cave_serve_websocket_message_invalid"); }
    if (payload !== null && typeof payload === "object" && !Array.isArray(payload) &&
        (payload as { type?: unknown }).type === "cancel") {
      state.controller?.clear();
      if (state.active !== undefined) await this.driver.cancel(state.active);
      return;
    }
    if (payload === null || typeof payload !== "object" || Array.isArray(payload) ||
        (payload as { type?: unknown }).type !== "message") {
      throw new Error("cave_serve_websocket_message_invalid");
    }
    const response = await this.acceptMessage(state, payload);
    if (!response.ok) throw new Error((await response.json() as { error?: string }).error ??
      "cave_serve_websocket_message_invalid");
  }

  private async loadDecoded(rawId: string): Promise<SessionState | Response> {
    let sessionId: string;
    try { sessionId = validateSessionId(decodeURIComponent(rawId)); }
    catch { return json(400, { error: "cave_durable_run_id_invalid" }); }
    const state = await this.load(sessionId);
    return state ?? json(404, { error: "cave_serve_not_found" });
  }

  private async load(sessionId: string): Promise<SessionState | undefined> {
    if (this.deleted.has(sessionId)) return undefined;
    const existing = this.sessions.get(sessionId);
    if (existing !== undefined) return existing;
    if (this.store.list === undefined) return undefined;
    const rows = (await this.store.list()).flatMap((runId) => {
      const n = sessionRunNumber(sessionId, runId);
      return n === undefined ? [] : [{ runId, n }];
    }).sort((a, b) => a.n - b.n);
    const last = rows.at(-1);
    if (last === undefined) return undefined;
    const lines = await this.store.load(last.runId);
    const summary = durableRunSummary(lines);
    const checkpoints = runCheckpoints(lines, sessionId);
    const checkpoint = summary.status === "pending" ? checkpoints.base : checkpoints.terminal;
    const state = checkpoint === undefined
      ? { ...initialSession(sessionId), error: "cave_session_conversation_unrecoverable" }
      : initialSession(sessionId, checkpoint);
    state.runs.push(...rows.map((row) => row.runId));
    state.nextRun = last.n + 1;
    this.sessions.set(sessionId, state);
    return state;
  }

  private async ensureKernel(state: SessionState): Promise<void> {
    if (state.conversation !== undefined && state.controller !== undefined) return;
    const runtime = await import("./runtime.js");
    state.conversation = runtime.restoreConversation(state.checkpoint);
    state.controller = new runtime.AgentRunController();
  }
}
