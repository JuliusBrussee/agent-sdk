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
  /** Per run: next free chunk sequence and the journal's total bytes. */
  private readonly journal = new Map<string, { next: number; bytes: number }>();
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

  /**
   * Every chunk is created, never overwritten: the put is create-if-absent, and
   * a taken sequence means somebody else wrote there — the lock-free
   * `requestDurableCancel` is exactly that somebody — so the next free sequence
   * is re-derived and the write retried instead of silently replacing it.
   */
  async append(runId: string, data: string): Promise<void> {
    const lostLease = this.lost.get(runId);
    if (lostLease !== undefined) throw lostLease;
    if (utf8Bytes(data) > MAX_JOURNAL_BYTES) throw new Error("cave_durable_journal_limit");
    if (data === "") return;
    const prefix = this.journalPrefix(runId);
    const body = new TextEncoder().encode(data.endsWith("\n") ? data : `${data}\n`);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await this.assertStillHeld(runId);
      const state = this.journal.get(runId) ?? await this.seedJournal(runId);
      // Same cumulative bound the disk and SQL stores enforce: refuse the append
      // that would cross it, rather than accepting bytes `load()` then refuses
      // to read back for the rest of the run's life.
      if (state.bytes + body.byteLength > MAX_JOURNAL_BYTES) {
        throw new Error("cave_durable_journal_limit");
      }
      try {
        await this.storage.put(`${prefix}${sequenceKey(state.next)}`, body, { ifMatch: "" });
      } catch {
        this.journal.delete(runId);
        continue;
      }
      this.journal.set(runId, { next: state.next + 1, bytes: state.bytes + body.byteLength });
      return;
    }
    throw new Error(
      `cave_durable_append_conflict: could not claim a free journal sequence for run "${runId}"`,
    );
  }

  /**
   * Highest written sequence and total journal bytes, once per run per process.
   *
   * ponytail: sizes come from reading the chunks, the same walk `load()` does,
   * because `ObjectStorage.list` returns keys only. A size-carrying listing
   * would make this one request instead of one per chunk.
   */
  private async seedJournal(runId: string): Promise<{ next: number; bytes: number }> {
    const prefix = this.journalPrefix(runId);
    const keys = [...await this.storage.list(prefix)].sort();
    let bytes = 0;
    for (const key of keys) {
      bytes += (await this.storage.get(key))?.byteLength ?? 0;
    }
    const last = keys.at(-1);
    const highest = last === undefined ? 0 : Number(last.slice(prefix.length));
    const state = {
      next: Number.isSafeInteger(highest) ? highest + 1 : keys.length,
      bytes,
    };
    this.journal.set(runId, state);
    return state;
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
    // ponytail: superseded lease keys are left in place — `ObjectStorage` has no
    // delete, and adding one changes a published type. One key per takeover, and
    // takeovers are expiries; add a delete primitive if a run ever churns enough
    // holders for the prefix listing to matter.
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

  /**
   * Is the generation this process created still the newest one under the lease
   * prefix? A takeover after an expiry creates a *higher* generation, so this is
   * the only question that can tell a stale holder it lost — reading its own key
   * back can only ever report itself.
   */
  private async stillNewestGeneration(runId: string, key: string): Promise<boolean> {
    const keys = [...await this.storage.list(this.leasePrefix(runId))].sort();
    return keys.at(-1) === key;
  }

  /** Losing the lease poisons the run rather than risking two drivers. */
  private markLost(runId: string, failure: Error): void {
    const held = this.leases.get(runId);
    if (held !== undefined) clearInterval(held.timer);
    this.leases.delete(runId);
    this.lost.set(runId, failure);
  }

  /**
   * An append by a process that holds this run's lease must still be able to
   * prove it holds it. A store with no lease here is a deliberately lock-free
   * writer (`requestDurableCancel`) and is not asked to prove anything.
   */
  private async assertStillHeld(runId: string): Promise<void> {
    const held = this.leases.get(runId);
    if (held === undefined) return;
    if (await this.stillNewestGeneration(runId, held.key)) return;
    this.markLost(runId, new Error(
      `cave_durable_run_lock_lost: run "${runId}" was taken over by another process`,
    ));
    throw this.lost.get(runId)!;
  }

  /** Losing the lease poisons the run rather than risking two drivers. */
  private async renew(runId: string, owner: string, key: string): Promise<void> {
    const held = this.leases.get(runId);
    if (held === undefined || held.owner !== owner) return;
    let failure: Error | undefined;
    try {
      // Order matters: prove the lease is still ours *before* writing a fresh
      // expiry into a key a newer generation has already superseded.
      if (!await this.stillNewestGeneration(runId, key)) {
        failure = new Error(
          `cave_durable_run_lock_lost: run "${runId}" was taken over by another process`,
        );
      } else {
        await this.putLease(key, { owner, expiresAt: Date.now() + this.leaseTtlMs }, false);
      }
    } catch (error) {
      failure = new Error("cave_durable_run_lock_lost", { cause: error });
    }
    if (failure === undefined) return;
    this.markLost(runId, failure);
  }

  async close(runId: string): Promise<void> {
    const held = this.leases.get(runId);
    if (held !== undefined) clearInterval(held.timer);
    this.leases.delete(runId);
    this.lost.delete(runId);
    this.journal.delete(runId);
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
