/**
 * A {@link DurableStore} over object storage (S3, R2, GCS, Azure Blob) behind
 * a three-method adapter.
 *
 * Object storage cannot append, so a journal is a sequence of immutable
 * chunk objects — `<prefix><runId>/journal/<seq>` — concatenated in key order
 * on load. Every chunk is written once and never rewritten, which is the same
 * property the disk store's append-only file has.
 *
 * ```ts
 * new ObjectDurableStore({
 *   storage: {
 *     get: async (key) => …,          // undefined when absent
 *     put: async (key, data, opts) => …,
 *     list: async (prefix) => …,      // every key under the prefix
 *   },
 *   conditionalPut: true,
 * });
 * ```
 *
 * ## The lease, and why `conditionalPut` is not optional
 *
 * `acquire` has to admit exactly one driver. With `get`/`put`/`list` alone
 * that is impossible: two processes can both `get` nothing and both `put`.
 * The one primitive that closes it is a **create-if-absent** put, which every
 * major object store offers (S3 and R2 `If-None-Match: *`, GCS
 * `ifGenerationMatch: 0`, Azure `If-None-Match: *`). This store expresses it
 * as `put(key, data, { ifMatch: "" })` — the empty string means "only if this
 * key does not exist yet" — and takes the lease by creating a *new* key
 * (`lease/<n+1>`), so a takeover after an expiry is a create, never an
 * overwrite, and stays single-winner.
 *
 * An adapter that silently ignores `opts` would turn that into a lock which
 * looks taken and is not, so support is not guessed: `conditionalPut` must be
 * declared, and `acquire` fails closed with
 * `cave_durable_object_conditional_put_required` when it is not.
 */

import { MAX_JOURNAL_BYTES, RUN_ID_PATTERN, utf8Bytes, validateDurableRunId } from "./durable-limits.js";
import type { DurableStore } from "./durable.js";

export interface ObjectStorage {
  get(key: string): Promise<Uint8Array | undefined>;
  /**
   * `opts.ifMatch === ""` must create the object only if the key is absent and
   * reject (throw) otherwise. Any other value is never passed by this store.
   */
  put(key: string, data: Uint8Array, opts?: { ifMatch?: string }): Promise<void>;
  list(prefix: string): Promise<readonly string[]>;
}

export interface ObjectDurableStoreOptions {
  readonly storage: ObjectStorage;
  /** Key namespace. Default `caveman/durable/`. */
  readonly prefix?: string;
  /** Declare that `storage.put` honors `ifMatch: ""` as create-if-absent. */
  readonly conditionalPut?: boolean;
  /** Lease length; the holder renews at a third of it. Default 30s. */
  readonly leaseTtlMs?: number;
}

type Lease = { readonly owner: string; readonly expiresAt: number };

const SEQUENCE_WIDTH = 12;

function sequenceKey(index: number): string {
  return String(index).padStart(SEQUENCE_WIDTH, "0");
}

export class ObjectDurableStore implements DurableStore {
  private readonly storage: ObjectStorage;
  private readonly prefix: string;
  private readonly conditionalPut: boolean;
  private readonly leaseTtlMs: number;
  private readonly nextChunk = new Map<string, number>();
  private readonly leases = new Map<
    string,
    { owner: string; key: string; timer: ReturnType<typeof setInterval> }
  >();
  private readonly lost = new Map<string, Error>();

  constructor(options: ObjectDurableStoreOptions) {
    this.storage = options.storage;
    this.prefix = options.prefix ?? "caveman/durable/";
    this.conditionalPut = options.conditionalPut === true;
    this.leaseTtlMs = options.leaseTtlMs ?? 30_000;
    if (!Number.isSafeInteger(this.leaseTtlMs) || this.leaseTtlMs < 3_000) {
      throw new Error("cave_durable_object_lease_ttl_invalid: lease must be at least 3000ms");
    }
  }

  private journalPrefix(runId: string): string {
    validateDurableRunId(runId);
    return `${this.prefix}${runId}/journal/`;
  }

  private leasePrefix(runId: string): string {
    validateDurableRunId(runId);
    return `${this.prefix}${runId}/lease/`;
  }

  async load(runId: string): Promise<readonly string[]> {
    const prefix = this.journalPrefix(runId);
    const keys = [...await this.storage.list(prefix)].sort();
    const lines: string[] = [];
    let bytes = 0;
    for (const key of keys) {
      const chunk = await this.storage.get(key);
      if (chunk === undefined) continue;
      bytes += chunk.byteLength;
      if (bytes > MAX_JOURNAL_BYTES) throw new Error("cave_durable_journal_limit");
      const text = new TextDecoder().decode(chunk);
      // Same rule as the disk store: only newline-terminated lines count. A
      // chunk is written whole, so this only ever trims a writer that died
      // between building the bytes and the store accepting them.
      const complete = text.slice(0, text.lastIndexOf("\n") + 1);
      if (complete === "") continue;
      lines.push(...complete.slice(0, -1).split("\n"));
    }
    return lines;
  }

  async append(runId: string, data: string): Promise<void> {
    const lostLease = this.lost.get(runId);
    if (lostLease !== undefined) throw lostLease;
    if (utf8Bytes(data) > MAX_JOURNAL_BYTES) throw new Error("cave_durable_journal_limit");
    if (data === "") return;
    const prefix = this.journalPrefix(runId);
    let next = this.nextChunk.get(runId);
    if (next === undefined) {
      // One listing per run per process; after that the counter is authoritative
      // because this process holds the lease and nobody else may write here.
      next = (await this.storage.list(prefix)).length;
    }
    const body = data.endsWith("\n") ? data : `${data}\n`;
    await this.storage.put(`${prefix}${sequenceKey(next)}`, new TextEncoder().encode(body));
    this.nextChunk.set(runId, next + 1);
  }

  async acquire(runId: string): Promise<() => Promise<void>> {
    if (!this.conditionalPut) {
      throw new Error(
        "cave_durable_object_conditional_put_required: ObjectDurableStore needs a create-if-absent put " +
        "(ifMatch: \"\") to guarantee one driver per run; construct it with conditionalPut: true once the adapter honors it",
      );
    }
    const prefix = this.leasePrefix(runId);
    const locked = () => new Error(
      `cave_durable_run_locked: run "${runId}" is already being driven by another process`,
    );
    const keys = [...await this.storage.list(prefix)].sort();
    const current = keys.at(-1);
    let generation = 0;
    if (current !== undefined) {
      generation = Number(current.slice(prefix.length));
      if (!Number.isSafeInteger(generation)) throw new Error("cave_durable_object_lease_invalid");
      const held = await this.readLease(current);
      // An unreadable lease is a held lease: ambiguity fails closed rather than
      // risking two processes double-spending one run.
      if (held === undefined || held.expiresAt > Date.now()) throw locked();
    }
    const owner = globalThis.crypto.randomUUID();
    const key = `${prefix}${sequenceKey(generation + 1)}`;
    try {
      await this.putLease(key, { owner, expiresAt: Date.now() + this.leaseTtlMs }, true);
    } catch {
      throw locked();
    }
    const timer = setInterval(() => {
      void this.renew(runId, owner, key);
    }, Math.floor(this.leaseTtlMs / 3));
    timer.unref?.();
    this.leases.set(runId, { owner, key, timer });
    this.lost.delete(runId);
    return async () => {
      const held = this.leases.get(runId);
      if (held === undefined || held.owner !== owner) return;
      clearInterval(held.timer);
      this.leases.delete(runId);
      // Release by expiring in place. Only the holder writes this key, so the
      // overwrite is uncontended, and the next acquirer creates the next
      // generation rather than racing for this one.
      await this.putLease(key, { owner, expiresAt: 0 }, false).catch(() => undefined);
    };
  }

  private async readLease(key: string): Promise<Lease | undefined> {
    let parsed: unknown;
    try {
      const raw = await this.storage.get(key);
      if (raw === undefined) return undefined;
      parsed = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return undefined;
    }
    if (parsed === null || typeof parsed !== "object") return undefined;
    const record = parsed as Record<string, unknown>;
    if (typeof record.owner !== "string" || !Number.isFinite(record.expiresAt)) return undefined;
    return { owner: record.owner, expiresAt: Number(record.expiresAt) };
  }

  private async putLease(key: string, lease: Lease, create: boolean): Promise<void> {
    const body = new TextEncoder().encode(JSON.stringify(lease));
    await this.storage.put(key, body, create ? { ifMatch: "" } : undefined);
  }

  /** Losing the lease poisons the run rather than risking two drivers. */
  private async renew(runId: string, owner: string, key: string): Promise<void> {
    const held = this.leases.get(runId);
    if (held === undefined || held.owner !== owner) return;
    let failure: Error | undefined;
    try {
      await this.putLease(key, { owner, expiresAt: Date.now() + this.leaseTtlMs }, false);
      const readBack = await this.readLease(key);
      if (readBack?.owner !== owner) failure = new Error("cave_durable_object_lock_lost");
    } catch (error) {
      failure = new Error("cave_durable_object_lock_lost", { cause: error });
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
    this.nextChunk.delete(runId);
  }

  async list(): Promise<readonly string[]> {
    const keys = await this.storage.list(this.prefix);
    const runIds = new Set<string>();
    for (const key of keys) {
      const runId = key.slice(this.prefix.length).split("/")[0];
      if (runId !== undefined && RUN_ID_PATTERN.test(runId)) runIds.add(runId);
    }
    return [...runIds].sort();
  }
}
