/**
 * The two {@link DurableStore} implementations that ship with the framework:
 * local disk for a machine with a real volume, HTTP for one without.
 *
 * Split out of `durable.ts` because they are storage, not semantics. The
 * journal's meaning — what an event means, when a resume is safe, how spend is
 * reconstructed — lives in `durable.ts`; these two only promise that bytes
 * appended in order are still there after a crash, and that one process at a
 * time may drive a run.
 */

import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { resolve } from "node:path";
import {
  MAX_JOURNAL_BYTES,
  RUN_ID_PATTERN,
  isPlainRecord,
  utf8Bytes,
  validateDurableRunId,
} from "./durable-limits.js";
import type { DurableStore } from "./durable.js";

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
      const path = resolve(this.runDir(runId), "journal.jsonl");
      const metadata = await stat(path);
      if (metadata.size > MAX_JOURNAL_BYTES) throw new Error("cave_durable_journal_limit");
      raw = await readFile(path, "utf8");
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
    if (utf8Bytes(data) > MAX_JOURNAL_BYTES) throw new Error("cave_durable_journal_limit");
    const path = resolve(this.runDir(runId), "journal.jsonl");
    try {
      const metadata = await stat(path);
      if (metadata.size + utf8Bytes(data) > MAX_JOURNAL_BYTES) {
        throw new Error("cave_durable_journal_limit");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
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

  /**
   * The runId of every journal under the root, read from each journal's own
   * `run_started` event rather than reconstructed from the directory name —
   * the name carries a digest suffix and is not the identity. A directory
   * without a readable first event is skipped: an unreadable journal is not
   * a run this store can name, and inventing an id would be worse than
   * omitting it.
   */
  async list(): Promise<readonly string[]> {
    let entries: Dirent[];
    try {
      entries = await readdir(this.root, { withFileTypes: true, encoding: "utf8" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const runIds: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const line = await this.firstLine(resolve(this.root, entry.name, "journal.jsonl"));
      if (line === undefined) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isPlainRecord(parsed) || parsed.type !== "run_started" ||
          typeof parsed.runId !== "string" || !RUN_ID_PATTERN.test(parsed.runId)) {
        continue;
      }
      runIds.push(parsed.runId);
    }
    return runIds.sort();
  }

  /** First newline-terminated line, without reading a multi-megabyte journal. */
  private async firstLine(path: string): Promise<string | undefined> {
    let handle: FileHandle;
    try {
      handle = await open(path, "r");
    } catch {
      return undefined;
    }
    try {
      const buffer = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const text = buffer.subarray(0, bytesRead).toString("utf8");
      const end = text.indexOf("\n");
      return end === -1 ? undefined : text.slice(0, end);
    } finally {
      await handle.close();
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP journal store
// ---------------------------------------------------------------------------

/**
 * Wire contract a {@link HttpDurableStore} endpoint must implement. Every
 * request carries `Authorization: Bearer <token>`; every response outside the
 * documented set is a failure, never an empty journal.
 *
 * - `GET    {base}/runs`                  → `{"runIds": [...]}`
 * - `GET    {base}/runs/{id}/journal`     → the raw journal text (404 = none)
 * - `POST   {base}/runs/{id}/journal`     → 204 once the bytes are DURABLE
 * - `POST   {base}/runs/{id}/lock`        → `{"token","expiresAt"}` | 409 held
 * - `POST   {base}/runs/{id}/lock/renew`  → 204 | 409 lease lost
 * - `DELETE {base}/runs/{id}/lock`        → 204
 *
 * The 204 on append is the whole guarantee: a server that answers before the
 * write is durable turns this store into a liar and the resume math with it.
 */
export interface HttpDurableStoreOptions {
  /** Base URL of the journal service. Must be https:// outside localhost. */
  url: string;
  /** Bearer token. Required — an unauthenticated journal is an open ledger. */
  token: string;
  /** Injectable transport, for tests and for platform-native fetch bindings. */
  fetchFn?: typeof fetch;
  /** Lock lease length. The holder renews at a third of it. Default 30s. */
  lockTtlMs?: number;
  /** Per-request timeout. Default 10s. */
  requestTimeoutMs?: number;
}

/**
 * A {@link DurableStore} over HTTP, so the journal can outlive the process
 * AND the machine — the shape a container platform needs, where local disk is
 * scratch space that disappears with the instance.
 *
 * Two deliberate refusals:
 *
 * - **Appends are never retried.** A retried append after an ambiguous
 *   failure could duplicate journal events, and a duplicated `call_settled`
 *   is silently wrong money. The append fails, the run fails, and the resume
 *   re-drives from a journal that is still true.
 * - **A lost lock lease poisons the store.** The lease is what stops two
 *   instances driving one run. If a renewal fails, this process can no longer
 *   prove it is the only driver, so every later append throws rather than
 *   writing into a journal another instance may now own.
 */
export class HttpDurableStore implements DurableStore {
  private readonly base: string;
  private readonly token: string;
  private readonly fetchFn: typeof fetch;
  private readonly lockTtlMs: number;
  private readonly requestTimeoutMs: number;
  private readonly leases = new Map<string, { token: string; timer: NodeJS.Timeout }>();
  private readonly lost = new Map<string, Error>();

  constructor(options: HttpDurableStoreOptions) {
    const url = new URL(options.url);
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      throw new Error("cave_durable_http_insecure: journal URL must be https outside localhost");
    }
    if (typeof options.token !== "string" || options.token === "") {
      throw new Error("cave_durable_http_token_required");
    }
    this.base = url.href.replace(/\/+$/, "");
    this.token = options.token;
    this.fetchFn = options.fetchFn ?? fetch;
    this.lockTtlMs = options.lockTtlMs ?? 30_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.lockTtlMs) || this.lockTtlMs < 3_000) {
      throw new Error("cave_durable_http_lock_ttl_invalid: lease must be at least 3000ms");
    }
  }

  private async request(
    method: string,
    path: string,
    body?: string,
  ): Promise<{ status: number; text: string }> {
    const signal = AbortSignal.timeout(this.requestTimeoutMs);
    const response = await this.fetchFn(`${this.base}${path}`, {
      method,
      signal,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body }),
    });
    return { status: response.status, text: await response.text() };
  }

  private runPath(runId: string): string {
    validateDurableRunId(runId);
    return `/runs/${encodeURIComponent(runId)}`;
  }

  async load(runId: string): Promise<readonly string[]> {
    const { status, text } = await this.request("GET", `${this.runPath(runId)}/journal`);
    if (status === 404) return [];
    if (status !== 200) throw new Error(`cave_durable_http_load_failed: HTTP ${status}`);
    if (utf8Bytes(text) > MAX_JOURNAL_BYTES) throw new Error("cave_durable_journal_limit");
    // Same torn-tail rule as the disk store: only newline-terminated lines count.
    const complete = text.slice(0, text.lastIndexOf("\n") + 1);
    return complete === "" ? [] : complete.slice(0, -1).split("\n");
  }

  async append(runId: string, data: string): Promise<void> {
    const lostLease = this.lost.get(runId);
    if (lostLease !== undefined) throw lostLease;
    if (utf8Bytes(data) > MAX_JOURNAL_BYTES) throw new Error("cave_durable_journal_limit");
    const lease = this.leases.get(runId);
    const { status } = await this.request(
      "POST",
      `${this.runPath(runId)}/journal`,
      JSON.stringify({ data, ...(lease === undefined ? {} : { lock: lease.token }) }),
    );
    if (status !== 204) throw new Error(`cave_durable_http_append_failed: HTTP ${status}`);
  }

  async acquire(runId: string): Promise<() => Promise<void>> {
    const path = this.runPath(runId);
    const { status, text } = await this.request(
      "POST",
      `${path}/lock`,
      JSON.stringify({ ttlMs: this.lockTtlMs }),
    );
    if (status === 409) {
      throw new Error(
        `cave_durable_run_locked: run "${runId}" is already being driven by another instance`,
      );
    }
    if (status !== 200) throw new Error(`cave_durable_http_lock_failed: HTTP ${status}`);
    let lockToken: unknown;
    try {
      lockToken = (JSON.parse(text) as { token?: unknown }).token;
    } catch {
      throw new Error("cave_durable_http_lock_response_invalid");
    }
    if (typeof lockToken !== "string" || lockToken === "") {
      throw new Error("cave_durable_http_lock_response_invalid");
    }
    const timer = setInterval(() => {
      void this.renew(runId, lockToken as string);
    }, Math.floor(this.lockTtlMs / 3));
    timer.unref?.();
    this.leases.set(runId, { token: lockToken, timer });
    this.lost.delete(runId);
    return async () => {
      const held = this.leases.get(runId);
      if (held === undefined) return;
      clearInterval(held.timer);
      this.leases.delete(runId);
      await this.request("DELETE", `${path}/lock`, JSON.stringify({ token: held.token }))
        .catch(() => undefined);
    };
  }

  /** Lease renewal. Losing it poisons the run rather than risking two drivers. */
  private async renew(runId: string, lockToken: string): Promise<void> {
    const held = this.leases.get(runId);
    if (held === undefined || held.token !== lockToken) return;
    let failure: Error | undefined;
    try {
      const { status } = await this.request(
        "POST",
        `${this.runPath(runId)}/lock/renew`,
        JSON.stringify({ token: lockToken, ttlMs: this.lockTtlMs }),
      );
      if (status !== 204) failure = new Error(`cave_durable_http_lock_lost: HTTP ${status}`);
    } catch (error) {
      failure = new Error("cave_durable_http_lock_lost", { cause: error });
    }
    if (failure === undefined) return;
    clearInterval(held.timer);
    this.leases.delete(runId);
    this.lost.set(runId, failure);
  }

  async close(runId: string): Promise<void> {
    const held = this.leases.get(runId);
    if (held !== undefined) clearInterval(held.timer);
    this.leases.delete(runId);
    this.lost.delete(runId);
  }

  async list(): Promise<readonly string[]> {
    const { status, text } = await this.request("GET", "/runs");
    if (status !== 200) throw new Error(`cave_durable_http_list_failed: HTTP ${status}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("cave_durable_http_list_invalid");
    }
    const runIds = isPlainRecord(parsed) ? parsed.runIds : undefined;
    if (!Array.isArray(runIds) ||
        !runIds.every((id): id is string => typeof id === "string" && RUN_ID_PATTERN.test(id))) {
      throw new Error("cave_durable_http_list_invalid");
    }
    return runIds;
  }
}

// ---------------------------------------------------------------------------
// Journal writer
