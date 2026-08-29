import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isUtf8 } from "node:buffer";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { killProcessTree, portableInvocation } from "./portable-process.js";

export type CommandSessionState =
  | "running"
  | "exited"
  | "timed_out"
  | "killed"
  | "unknown_after_restart";

export interface CommandSessionRuntimeOptions {
  /** Maximum simultaneously retained sessions. Completed sessions are evicted first. */
  maxSessions?: number;
  /** Maximum retained output bytes per session. Older bytes are discarded first. */
  maxOutputBytes?: number;
  /** Maximum bytes returned by one read. */
  maxReadBytes?: number;
  /** Maximum bytes accepted by one stdin write. */
  maxInputBytes?: number;
  /** Maximum hard process lifetime. */
  maxTimeoutMs?: number;
  /** Maximum long-poll duration for one read. */
  maxWaitMs?: number;
}

export interface CommandSessionStartOptions {
  command: string;
  args?: readonly string[];
  cwd: string;
  /** Explicit child environment. Ambient `process.env` is never inherited. */
  env: NodeJS.ProcessEnv;
  /** Session commands keep stdin writable by default; foreground callers may close it at launch. */
  stdin?: "pipe" | "closed";
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface CommandSessionStartResult {
  readonly sessionId: string;
  readonly state: "running";
}

export interface CommandSessionReadOptions {
  sessionId: string;
  /** Absolute byte position in this session's combined stdout/stderr stream. */
  cursor?: number;
  limit?: number;
  /** Wait until bytes after `cursor` arrive or the process stops. */
  waitMs?: number;
  /** Cancels this read only. It never kills the session. */
  signal?: AbortSignal;
}

export interface CommandSessionReadResult {
  readonly sessionId: string;
  readonly state: CommandSessionState;
  /** Requested absolute cursor. */
  readonly cursor: number;
  /** Absolute cursor of the first returned byte. May advance when old bytes were evicted. */
  readonly outputStart: number;
  /** Absolute cursor immediately after the returned bytes. */
  readonly nextCursor: number;
  /** `base64` preserves an exact page whose byte boundaries are not valid UTF-8. */
  readonly outputEncoding: "utf8" | "base64";
  readonly output: string;
  readonly availableFrom: number;
  readonly availableTo: number;
  readonly truncatedBeforeCursor: boolean;
  readonly hasMore: boolean;
  readonly exitCode: number | null;
  readonly exitSignal: NodeJS.Signals | null;
  readonly spawnError?: string;
}

export interface CommandSessionWriteOptions {
  sessionId: string;
  input: string;
  /** Cancels this write operation only. It never kills the session. */
  signal?: AbortSignal;
}

export interface CommandSessionWriteResult {
  readonly sessionId: string;
  readonly state: CommandSessionState;
  readonly accepted: boolean;
  readonly bytes: number;
}

export interface CommandSessionRuntime {
  start(options: CommandSessionStartOptions): Promise<CommandSessionStartResult>;
  read(options: CommandSessionReadOptions): Promise<CommandSessionReadResult>;
  write(options: CommandSessionWriteOptions): Promise<CommandSessionWriteResult>;
  kill(sessionId: string): Promise<CommandSessionReadResult>;
  /** Kill every live child and wait for local handles to close. Idempotent. */
  close(): Promise<void>;
}

type TerminalState = Exclude<CommandSessionState, "running" | "unknown_after_restart">;

/** Growable circular byte buffer. Append cost stays linear in new bytes. */
class BoundedByteRing {
  private storage = Buffer.alloc(0);
  private head = 0;
  private length = 0;

  constructor(private readonly maximum: number) {}

  get byteLength(): number {
    return this.length;
  }

  append(input: Buffer): number {
    if (input.byteLength === 0) return 0;
    const previousLength = this.length;
    if (input.byteLength >= this.maximum) {
      this.ensureCapacity(this.maximum);
      input.copy(this.storage, 0, input.byteLength - this.maximum);
      this.head = 0;
      this.length = this.maximum;
      return previousLength + input.byteLength - this.maximum;
    }
    this.ensureCapacity(Math.min(this.maximum, this.length + input.byteLength));
    const overflow = Math.max(0, this.length + input.byteLength - this.maximum);
    if (overflow > 0) {
      this.head = (this.head + overflow) % this.storage.byteLength;
      this.length -= overflow;
    }
    const tail = (this.head + this.length) % this.storage.byteLength;
    const first = Math.min(input.byteLength, this.storage.byteLength - tail);
    input.copy(this.storage, tail, 0, first);
    if (first < input.byteLength) input.copy(this.storage, 0, first);
    this.length += input.byteLength;
    return overflow;
  }

  /** Drop an incomplete UTF-8 prefix left by byte-cap eviction. */
  alignUtf8Start(): number {
    let dropped = 0;
    while (this.length > 0 && dropped < 3) {
      const byte = this.storage[this.head]!;
      if ((byte & 0xc0) !== 0x80) break;
      this.head = (this.head + 1) % this.storage.byteLength;
      this.length--;
      dropped++;
    }
    return dropped;
  }

  slice(start: number, end: number): Buffer {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
        start < 0 || end < start || end > this.length) {
      throw new Error("command_session_output_range_invalid");
    }
    const result = Buffer.allocUnsafe(end - start);
    this.copyInto(result, 0, start, end - start);
    return result;
  }

  clear(): void {
    this.storage = Buffer.alloc(0);
    this.head = 0;
    this.length = 0;
  }

  private ensureCapacity(required: number): void {
    if (required <= this.storage.byteLength) return;
    const doubled = this.storage.byteLength === 0 ? 64 : this.storage.byteLength * 2;
    const capacity = Math.min(this.maximum, Math.max(required, doubled));
    const next = Buffer.allocUnsafe(capacity);
    this.copyInto(next, 0, 0, this.length);
    this.storage = next;
    this.head = 0;
  }

  private copyInto(
    target: Buffer,
    targetStart: number,
    sourceStart: number,
    length: number,
  ): void {
    if (length === 0) return;
    const physical = (this.head + sourceStart) % this.storage.byteLength;
    const first = Math.min(length, this.storage.byteLength - physical);
    this.storage.copy(target, targetStart, physical, physical + first);
    if (first < length) this.storage.copy(target, targetStart + first, 0, length - first);
  }
}

type CommandSession = {
  readonly id: string;
  readonly child: ChildProcessWithoutNullStreams;
  readonly waiters: Set<() => void>;
  readonly done: Promise<void>;
  resolveDone(): void;
  readonly abortSignal?: AbortSignal;
  abortListener?: () => void;
  readonly output: BoundedByteRing;
  availableTo: number;
  state: CommandSessionState;
  requestedState?: Extract<TerminalState, "timed_out" | "killed">;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  spawnError?: string;
  timer?: NodeJS.Timeout;
  finishTimer?: NodeJS.Timeout;
  finalized: boolean;
};

const DEFAULT_MAX_SESSIONS = 64;
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_READ_BYTES = 64 * 1024;
const DEFAULT_MAX_INPUT_BYTES = 64 * 1024;
const DEFAULT_MAX_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_WAIT_MS = 30_000;
const EXIT_FLUSH_GRACE_MS = 100;
const FORCE_FINISH_MS = 500;
const SESSION_ID = /^cmd_[a-f0-9]{32}$/;

/**
 * Create an in-memory command-session owner. IDs deliberately name only this
 * runtime's children: unknown IDs are reported as `unknown_after_restart` and
 * are never adopted from operating-system process state.
 */
export function createCommandSessionRuntime(
  options: CommandSessionRuntimeOptions = {},
): CommandSessionRuntime {
  const maxSessions = positiveLimit(options.maxSessions, DEFAULT_MAX_SESSIONS, "maxSessions");
  const maxOutputBytes = positiveLimit(
    options.maxOutputBytes,
    DEFAULT_MAX_OUTPUT_BYTES,
    "maxOutputBytes",
  );
  const maxReadBytes = positiveLimit(options.maxReadBytes, DEFAULT_MAX_READ_BYTES, "maxReadBytes");
  const maxInputBytes = positiveLimit(
    options.maxInputBytes,
    DEFAULT_MAX_INPUT_BYTES,
    "maxInputBytes",
  );
  const maxTimeoutMs = positiveLimit(
    options.maxTimeoutMs,
    DEFAULT_MAX_TIMEOUT_MS,
    "maxTimeoutMs",
  );
  const maxWaitMs = positiveLimit(options.maxWaitMs, DEFAULT_MAX_WAIT_MS, "maxWaitMs");
  const sessions = new Map<string, CommandSession>();
  let closed = false;
  let closing: Promise<void> | undefined;

  const notify = (session: CommandSession) => {
    for (const waiter of [...session.waiters]) waiter();
    session.waiters.clear();
  };

  const append = (session: CommandSession, chunk: Buffer | string) => {
    if (session.finalized) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    session.availableTo += bytes.byteLength;
    const evicted = session.output.append(bytes);
    if (evicted > 0) session.output.alignUtf8Start();
    notify(session);
  };

  const finalize = (
    session: CommandSession,
    fallbackState: TerminalState = "exited",
  ) => {
    if (session.finalized) return;
    session.finalized = true;
    session.state = session.requestedState ?? fallbackState;
    if (session.timer !== undefined) clearTimeout(session.timer);
    if (session.finishTimer !== undefined) clearTimeout(session.finishTimer);
    session.abortSignal?.removeEventListener("abort", session.abortListener!);
    session.child.stdin.destroy();
    session.child.stdout.destroy();
    session.child.stderr.destroy();
    notify(session);
    session.resolveDone();
  };

  const requestStop = (
    session: CommandSession,
    state: Extract<TerminalState, "timed_out" | "killed">,
  ) => {
    if (session.finalized || session.requestedState !== undefined) return;
    session.requestedState = state;
    try {
      killProcessTree(session.child);
    } catch {
      try { session.child.kill("SIGKILL"); } catch { /* process already stopped */ }
    }
    // SIGKILL/taskkill should produce `exit`/`close`; this bound also releases
    // pipes when a platform fails to report child completion.
    session.finishTimer = setTimeout(() => finalize(session, state), FORCE_FINISH_MS);
  };

  const evictCompletedForStart = () => {
    while (sessions.size >= maxSessions) {
      const completed = [...sessions].find(([, session]) => session.finalized);
      if (completed === undefined) {
        throw new Error("command_session_limit_reached");
      }
      completed[1].output.clear();
      sessions.delete(completed[0]);
    }
  };

  const read = async (input: CommandSessionReadOptions): Promise<CommandSessionReadResult> => {
    const cursor = nonNegativeInteger(input.cursor ?? 0, "cursor");
    const limit = positiveBoundedInteger(input.limit ?? maxReadBytes, maxReadBytes, "limit");
    const waitMs = nonNegativeBoundedInteger(input.waitMs ?? 0, maxWaitMs, "waitMs");
    throwIfOperationAborted(input.signal);
    validateSessionId(input.sessionId);
    const session = sessions.get(input.sessionId);
    if (session === undefined) return unknownRead(input.sessionId, cursor);
    if (cursor > session.availableTo) {
      throw new Error("command_session_cursor_beyond_output");
    }
    if (waitMs > 0 && session.state === "running" && cursor >= session.availableTo) {
      await waitForChange(session, cursor, waitMs, input.signal);
    }
    const availableFrom = session.availableTo - session.output.byteLength;
    const outputStart = Math.max(cursor, availableFrom);
    let nextCursor = Math.min(session.availableTo, outputStart + limit);
    let page = session.output.slice(outputStart - availableFrom, nextCursor - availableFrom);
    let outputEncoding: "utf8" | "base64" = isUtf8(page) ? "utf8" : "base64";
    // Normal text pages should not become base64 because `limit` cut through
    // their final code point. Move end back by at most UTF-8's three trailing
    // bytes; cursor remains absolute and next read begins at that code point.
    if (outputEncoding === "base64") {
      for (let trim = 1; trim <= 3 && trim < page.byteLength; trim++) {
        const candidate = page.subarray(0, page.byteLength - trim);
        if (!isUtf8(candidate)) continue;
        page = candidate;
        nextCursor -= trim;
        outputEncoding = "utf8";
        break;
      }
    }
    return Object.freeze({
      sessionId: session.id,
      state: session.state,
      cursor,
      outputStart,
      nextCursor,
      outputEncoding,
      output: page.toString(outputEncoding),
      availableFrom,
      availableTo: session.availableTo,
      truncatedBeforeCursor: cursor < availableFrom,
      hasMore: nextCursor < session.availableTo,
      exitCode: session.exitCode,
      exitSignal: session.exitSignal,
      ...(session.spawnError === undefined ? {} : { spawnError: session.spawnError }),
    });
  };

  const runtime: CommandSessionRuntime = {
    async start(input) {
      if (closed) throw new Error("command_session_runtime_closed");
      validateStart(input, maxTimeoutMs);
      evictCompletedForStart();
      const env = cloneExplicitEnv(input.env);
      let invocation;
      try {
        invocation = portableInvocation(input.command, input.args ?? [], { env });
      } catch (error) {
        throw new Error(`command_session_launch_invalid:${errorMessage(error)}`);
      }
      const id = `cmd_${randomUUID().replaceAll("-", "")}`;
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(invocation.command, [...invocation.args], {
          cwd: input.cwd,
          env,
          stdio: ["pipe", "pipe", "pipe"],
          detached: process.platform !== "win32",
          windowsHide: true,
        });
      } catch (error) {
        throw new Error(`command_session_spawn_failed:${errorMessage(error)}`);
      }
      let resolveDone!: () => void;
      const done = new Promise<void>((accept) => { resolveDone = accept; });
      const session: CommandSession = {
        id,
        child,
        waiters: new Set(),
        done,
        resolveDone,
        ...(input.signal === undefined ? {} : { abortSignal: input.signal }),
        output: new BoundedByteRing(maxOutputBytes),
        availableTo: 0,
        state: "running",
        exitCode: null,
        exitSignal: null,
        finalized: false,
      };
      sessions.set(id, session);
      child.stdout.on("data", (chunk: Buffer) => append(session, chunk));
      child.stderr.on("data", (chunk: Buffer) => append(session, chunk));
      child.once("error", (error) => {
        session.spawnError = errorMessage(error);
        finalize(session);
      });
      child.once("close", (code, signal) => {
        session.exitCode = code;
        session.exitSignal = signal;
        try { killProcessTree(child); } catch { /* group already exited */ }
        finalize(session);
      });
      child.once("exit", (code, signal) => {
        session.exitCode = code;
        session.exitSignal = signal;
        // A background descendant can retain stdio after shell exit. It is not
        // adopted as a daemon: allow final pipe bytes, kill group, then finish.
        if (session.finishTimer !== undefined) clearTimeout(session.finishTimer);
        session.finishTimer = setTimeout(() => {
          try { killProcessTree(child); } catch { /* group already exited */ }
          finalize(session);
        }, EXIT_FLUSH_GRACE_MS);
      });
      session.timer = setTimeout(() => requestStop(session, "timed_out"), input.timeoutMs);
      if (input.signal !== undefined) {
        const abort = () => requestStop(session, "killed");
        session.abortListener = abort;
        input.signal.addEventListener("abort", abort, { once: true });
        if (input.signal.aborted) abort();
      }
      if (input.stdin === "closed") child.stdin.end();
      return Object.freeze({ sessionId: id, state: "running" as const });
    },

    read,

    async write(input) {
      throwIfOperationAborted(input.signal);
      validateSessionId(input.sessionId);
      if (typeof input.input !== "string") throw new Error("command_session_input_must_be_string");
      const bytes = Buffer.byteLength(input.input, "utf8");
      if (bytes > maxInputBytes) throw new Error("command_session_input_limit_exceeded");
      const session = sessions.get(input.sessionId);
      if (session === undefined) {
        return Object.freeze({
          sessionId: input.sessionId,
          state: "unknown_after_restart" as const,
          accepted: false,
          bytes: 0,
        });
      }
      if (session.state !== "running" ||
          session.child.stdin.destroyed ||
          session.child.stdin.writableEnded) {
        return Object.freeze({
          sessionId: input.sessionId,
          state: session.state,
          accepted: false,
          bytes: 0,
        });
      }
      const accepted = await new Promise<boolean>((accept) => {
        let settled = false;
        const finish = (value: boolean) => {
          if (settled) return;
          settled = true;
          input.signal?.removeEventListener("abort", abort);
          accept(value);
        };
        const abort = () => finish(false);
        input.signal?.addEventListener("abort", abort, { once: true });
        session.child.stdin.write(input.input, "utf8", (error) => {
          finish(error === null || error === undefined);
        });
        if (input.signal?.aborted === true) abort();
      });
      throwIfOperationAborted(input.signal);
      return Object.freeze({
        sessionId: input.sessionId,
        state: session.state,
        accepted,
        bytes: accepted ? bytes : 0,
      });
    },

    async kill(sessionId) {
      validateSessionId(sessionId);
      const session = sessions.get(sessionId);
      if (session === undefined) return unknownRead(sessionId, 0);
      requestStop(session, "killed");
      await session.done;
      return read({ sessionId, cursor: session.availableTo, limit: 1 });
    },

    close() {
      if (closing !== undefined) return closing;
      closed = true;
      closing = (async () => {
        const live = [...sessions.values()].filter((session) => !session.finalized);
        for (const session of live) requestStop(session, "killed");
        await Promise.all(live.map((session) => session.done));
        for (const session of sessions.values()) session.output.clear();
        sessions.clear();
      })();
      return closing;
    },
  };

  return Object.freeze(runtime);
}

function waitForChange(
  session: CommandSession,
  cursor: number,
  waitMs: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((accept, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      session.waiters.delete(finish);
      signal?.removeEventListener("abort", abort);
      if (error === undefined) accept();
      else reject(error);
    };
    const abort = () => finish(operationAbortedError());
    const timer = setTimeout(finish, waitMs);
    session.waiters.add(finish);
    signal?.addEventListener("abort", abort, { once: true });
    if (session.state !== "running" || session.availableTo > cursor) finish();
    else if (signal?.aborted === true) abort();
  });
}

function unknownRead(sessionId: string, cursor: number): CommandSessionReadResult {
  return Object.freeze({
    sessionId,
    state: "unknown_after_restart",
    cursor,
    outputStart: cursor,
    nextCursor: cursor,
    outputEncoding: "utf8",
    output: "",
    availableFrom: cursor,
    availableTo: cursor,
    truncatedBeforeCursor: false,
    hasMore: false,
    exitCode: null,
    exitSignal: null,
  });
}

function throwIfOperationAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw operationAbortedError();
}

function operationAbortedError(): Error {
  return new Error("command_session_operation_aborted");
}

function validateStart(input: CommandSessionStartOptions, maxTimeoutMs: number): void {
  if (typeof input.command !== "string" || input.command.length === 0 || input.command.includes("\0")) {
    throw new Error("command_session_command_invalid");
  }
  if (input.args !== undefined && (
    !Array.isArray(input.args) ||
    input.args.some((arg) => typeof arg !== "string" || arg.includes("\0"))
  )) {
    throw new Error("command_session_args_invalid");
  }
  if (typeof input.cwd !== "string" || !isAbsolute(input.cwd) || input.cwd.includes("\0")) {
    throw new Error("command_session_cwd_must_be_absolute");
  }
  if (input.env === undefined || input.env === null || Array.isArray(input.env)) {
    throw new Error("command_session_explicit_env_required");
  }
  if (input.stdin !== undefined && input.stdin !== "pipe" && input.stdin !== "closed") {
    throw new Error("command_session_stdin_invalid");
  }
  positiveBoundedInteger(input.timeoutMs, maxTimeoutMs, "timeoutMs");
}

function cloneExplicitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.length === 0 || key.includes("=") || key.includes("\0") ||
        typeof value !== "string" || value.includes("\0")) {
      throw new Error("command_session_env_invalid");
    }
    copy[key] = value;
  }
  return copy;
}

function validateSessionId(sessionId: string): void {
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) {
    throw new Error("command_session_id_invalid");
  }
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  return positiveBoundedInteger(value ?? fallback, Number.MAX_SAFE_INTEGER, name);
}

function positiveBoundedInteger(value: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new Error(`command_session_${name}_invalid`);
  }
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`command_session_${name}_invalid`);
  }
  return value;
}

function nonNegativeBoundedInteger(value: number, max: number, name: string): number {
  const checked = nonNegativeInteger(value, name);
  if (checked > max) throw new Error(`command_session_${name}_invalid`);
  return checked;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
