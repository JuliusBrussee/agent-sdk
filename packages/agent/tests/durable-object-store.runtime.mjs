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
