import { test } from "node:test";
import assert from "node:assert/strict";
import { ObjectDurableStore } from "../dist/durable.js";
import {
  assertDurableResume,
  assertExclusiveAcquire,
  assertJournalRoundTrip,
} from "./durable-store-contract.mjs";

/**
 * An in-memory object store. `conditional: false` models the adapter this
 * store must refuse to trust: one that cannot do a create-if-absent put.
 */
function objectStorage(options = {}) {
  const conditional = options.conditional !== false;
  const objects = new Map();
  return {
    objects,
    storage: {
      async get(key) {
        return objects.get(key);
      },
      async put(key, data, opts) {
        if (opts?.ifMatch !== undefined) {
          if (!conditional) throw new Error("adapter does not support conditional put");
          assert.equal(opts.ifMatch, "", "only create-if-absent is ever requested");
          if (objects.has(key)) throw new Error("PreconditionFailed");
        }
        objects.set(key, data);
      },
      async list(prefix) {
        return [...objects.keys()].filter((key) => key.startsWith(prefix));
      },
    },
  };
}

function store(options = {}) {
  const { storage, objects } = objectStorage(options);
  return {
    objects,
    storage,
    store: new ObjectDurableStore({ storage, conditionalPut: true, ...options }),
  };
}

test("appends load back in order and every run is listable", async () => {
  const scenario = store();
  await assertJournalRoundTrip(scenario.store);
  // Chunks are immutable objects under one key namespace, never rewritten.
  assert.equal(
    [...scenario.objects.keys()].filter((key) => key.startsWith("caveman/durable/round-trip/")).length,
    2,
  );
});

test("one driver at a time, across two store instances on one bucket", async () => {
  const { storage } = objectStorage();
  const first = new ObjectDurableStore({ storage, conditionalPut: true });
  const second = new ObjectDurableStore({ storage, conditionalPut: true });
  await assertExclusiveAcquire(first, second);
});

test("a crashed run resumes from its last completed turn", async () => {
  const scenario = store();
  await assertDurableResume(scenario.store, "object-resume");
});

test("an adapter without conditional put fails closed instead of faking a lock", async () => {
  const { storage, objects } = objectStorage({ conditional: false });
  const undeclared = new ObjectDurableStore({ storage });
  await assert.rejects(
    undeclared.acquire("unlockable"),
    /cave_durable_object_conditional_put_required/,
  );
  // Fails before it writes: an unenforced lease key is worse than none.
  assert.equal(objects.size, 0);
  // Declaring support an adapter does not have still cannot invent a lock:
  // the conditional put itself throws, and that reads as "held".
  const declared = new ObjectDurableStore({ storage, conditionalPut: true });
  await assert.rejects(declared.acquire("unlockable"), /cave_durable_run_locked/);
});

test("an expired lease is taken over by creating the next generation", async () => {
  const { storage, objects } = objectStorage();
  const holder = new ObjectDurableStore({ storage, conditionalPut: true, leaseTtlMs: 3_000 });
  const other = new ObjectDurableStore({ storage, conditionalPut: true, leaseTtlMs: 3_000 });
  await holder.acquire("expiring");
  await assert.rejects(other.acquire("expiring"), /cave_durable_run_locked/);

  const leaseKey = [...objects.keys()].find((key) => key.includes("/lease/"));
  const held = JSON.parse(new TextDecoder().decode(objects.get(leaseKey)));
  objects.set(
    leaseKey,
    new TextEncoder().encode(JSON.stringify({ ...held, expiresAt: Date.now() - 1 })),
  );

  const release = await other.acquire("expiring");
  const leaseKeys = [...objects.keys()].filter((key) => key.includes("/lease/")).sort();
  // The takeover is a create of the next generation, never an overwrite of the
  // expired one — which is what keeps it single-winner.
  assert.equal(leaseKeys.length, 2);
  assert.equal(leaseKeys.at(-1).endsWith("000000000002"), true);
  await release();
  await holder.close("expiring");
  await other.close("expiring");
});

test("an unreadable lease is treated as held", async () => {
  const { storage, objects } = objectStorage();
  const store = new ObjectDurableStore({ storage, conditionalPut: true });
  objects.set("caveman/durable/opaque/lease/000000000001", new TextEncoder().encode("{not json"));
  await assert.rejects(store.acquire("opaque"), /cave_durable_run_locked/);
});

test("a second writer never overwrites a chunk the first one already claimed", async () => {
  const { storage, objects } = objectStorage();
  const driver = new ObjectDurableStore({ storage, conditionalPut: true });
  // The lock-free writer `requestDurableCancel` uses: a different store
  // instance, appending to the same run without holding the lease.
  const control = new ObjectDurableStore({ storage, conditionalPut: true });
  await driver.append("interleaved", "turn one\n");
  await control.append("interleaved", "cancel_requested\n");
  await driver.append("interleaved", "turn two\n");
  assert.deepEqual(await driver.load("interleaved"), [
    "turn one",
    "cancel_requested",
    "turn two",
  ]);
  // Three lines, three chunk objects: nothing was written over.
  assert.equal(
    [...objects.keys()].filter((key) => key.startsWith("caveman/durable/interleaved/journal/")).length,
    3,
  );
  await driver.close("interleaved");
  await control.close("interleaved");
});

test("a holder that lost its lease to a takeover fails closed on append and renewal", async () => {
  const { storage, objects } = objectStorage();
  const holder = new ObjectDurableStore({ storage, conditionalPut: true, leaseTtlMs: 3_000 });
  const other = new ObjectDurableStore({ storage, conditionalPut: true, leaseTtlMs: 3_000 });
  await holder.acquire("lost-lease");
  await holder.append("lost-lease", "before\n");

  const leaseKey = [...objects.keys()].find((key) => key.includes("/lease/"));
  const held = JSON.parse(new TextDecoder().decode(objects.get(leaseKey)));
  const expired = { ...held, expiresAt: Date.now() - 1 };
  objects.set(leaseKey, new TextEncoder().encode(JSON.stringify(expired)));
  const release = await other.acquire("lost-lease");

  // The expired holder learns it lost from the newer generation, not from
  // reading its own key back — which could only ever report itself.
  await assert.rejects(holder.append("lost-lease", "after\n"), /cave_durable_run_lock_lost/);
  await assert.rejects(holder.append("lost-lease", "again\n"), /cave_durable_run_lock_lost/);
  // Its renewal tick stops rather than refreshing a superseded lease.
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.deepEqual(
    JSON.parse(new TextDecoder().decode(objects.get(leaseKey))),
    expired,
  );
  assert.deepEqual(await other.load("lost-lease"), ["before"]);
  await release();
  await holder.close("lost-lease");
  await other.close("lost-lease");
});

test("the append that would cross the journal bound is refused, not accepted and then unreadable", async () => {
  const { storage } = objectStorage();
  const store = new ObjectDurableStore({ storage, conditionalPut: true });
  // 256MiB of real bytes is not worth writing to prove a bound, so the
  // accounting is seeded with one chunk that already fills the journal.
  const filled = new Uint8Array(256 * 1024 * 1024);
  filled.fill(0x61);
  filled[filled.length - 1] = 0x0a;
  await storage.put("caveman/durable/capped/journal/000000000000", filled);
  await assert.rejects(store.append("capped", "one more line\n"), /cave_durable_journal_limit/);
  await store.close("capped");
});
