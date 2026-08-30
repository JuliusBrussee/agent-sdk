import assert from "node:assert/strict";
import test from "node:test";

import {
  MemorySessionStore,
  SessionConflictError,
} from "../dist/session.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const scope = { tenant: "tenant-1", sessionId: "session-1" };

function bytes(value) {
  return encoder.encode(value);
}

function text(record) {
  return decoder.decode(record.payload);
}

test("initial append creates branch and snapshots caller bytes", async () => {
  const store = new MemorySessionStore();
  const payload = bytes("one");
  const result = await store.append({
    scope,
    branchId: "main",
    expectedRevision: null,
    operationId: "run-1",
    payload,
  });
  payload[0] = 0;

  assert.equal(result.replayed, false);
  assert.equal(result.record.parentId, null);
  assert.equal(result.record.kind, "delta");
  assert.equal(text(result.record), "one");
  assert.match(result.record.payloadSha256, /^[0-9a-f]{64}$/);
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(await store.load({ scope, branchId: "main" }), result.branch);
  assert.deepEqual(
    (await store.path({ scope, recordId: result.record.id })).map(text),
    ["one"],
  );
});

test("CAS conflicts mutate nothing and concurrent writers cannot both win", async () => {
  const store = new MemorySessionStore();
  const first = await store.append({
    scope,
    branchId: "main",
    expectedRevision: null,
    operationId: "run-1",
    payload: bytes("one"),
  });
  const [left, right] = await Promise.allSettled([
    store.append({
      scope,
      branchId: "main",
      expectedRevision: first.branch.revision,
      operationId: "run-2a",
      payload: bytes("left"),
    }),
    store.append({
      scope,
      branchId: "main",
      expectedRevision: first.branch.revision,
      operationId: "run-2b",
      payload: bytes("right"),
    }),
  ]);
  assert.equal([left, right].filter((item) => item.status === "fulfilled").length, 1);
  const rejected = [left, right].find((item) => item.status === "rejected");
  assert.ok(rejected.reason instanceof SessionConflictError);

  const branch = await store.load({ scope, branchId: "main" });
  const path = await store.path({ scope, recordId: branch.headRecordId, view: "history" });
  assert.equal(path.length, 2);
});

test("exact operation replay survives later branch advancement", async () => {
  const store = new MemorySessionStore();
  const firstInput = {
    scope,
    branchId: "main",
    expectedRevision: null,
    operationId: "run-1",
    payload: bytes("one"),
  };
  const first = await store.append(firstInput);
  await store.append({
    scope,
    branchId: "main",
    expectedRevision: first.branch.revision,
    operationId: "run-2",
    payload: bytes("two"),
  });

  const replay = await store.append(firstInput);
  assert.equal(replay.replayed, true);
  assert.equal(replay.record.id, first.record.id);
  assert.equal(replay.branch.revision, first.branch.revision);
  await assert.rejects(
    store.append({ ...firstInput, payload: bytes("changed") }),
    /cave_session_operation_mismatch:run-1/,
  );
});

test("fork points at immutable history and branches advance independently", async () => {
  const store = new MemorySessionStore();
  const first = await store.append({
    scope,
    branchId: "main",
    expectedRevision: null,
    operationId: "run-1",
    payload: bytes("root"),
  });
  const second = await store.append({
    scope,
    branchId: "main",
    expectedRevision: first.branch.revision,
    operationId: "run-2",
    payload: bytes("main"),
  });
  const forked = await store.fork({
    scope,
    sourceRecordId: first.record.id,
    targetBranchId: "alternate",
    operationId: "fork-1",
  });
  const alternate = await store.append({
    scope,
    branchId: "alternate",
    expectedRevision: forked.branch.revision,
    operationId: "run-alt",
    payload: bytes("alternate"),
  });

  assert.deepEqual(
    (await store.path({ scope, recordId: second.record.id, view: "history" })).map(text),
    ["root", "main"],
  );
  assert.deepEqual(
    (await store.path({ scope, recordId: alternate.record.id, view: "history" })).map(text),
    ["root", "alternate"],
  );
  assert.deepEqual(
    (await store.listBranches(scope)).map((branch) => branch.branchId),
    ["alternate", "main"],
  );
  assert.equal((await store.fork({
    scope,
    sourceRecordId: first.record.id,
    targetBranchId: "alternate",
    operationId: "fork-1",
  })).replayed, true);
});

test("compaction keeps history and starts effective path at latest snapshot", async () => {
  const store = new MemorySessionStore();
  const first = await store.append({
    scope,
    branchId: "main",
    expectedRevision: null,
    operationId: "run-1",
    payload: bytes("one"),
  });
  const second = await store.append({
    scope,
    branchId: "main",
    expectedRevision: first.branch.revision,
    operationId: "run-2",
    payload: bytes("two"),
  });
  const compacted = await store.compact({
    scope,
    branchId: "main",
    expectedRevision: second.branch.revision,
    operationId: "compact-1",
    snapshot: bytes("one+two"),
  });
  const third = await store.append({
    scope,
    branchId: "main",
    expectedRevision: compacted.branch.revision,
    operationId: "run-3",
    payload: bytes("three"),
  });

  assert.deepEqual(
    (await store.path({ scope, recordId: third.record.id, view: "history" })).map(text),
    ["one", "two", "one+two", "three"],
  );
  assert.deepEqual(
    (await store.path({ scope, recordId: third.record.id })).map(text),
    ["one+two", "three"],
  );
  assert.equal(compacted.record.compactsThroughRecordId, second.record.id);
});

test("session inputs use own data snapshots and never inherit or invoke fields", async () => {
  const store = new MemorySessionStore();
  const first = await store.append({
    scope,
    branchId: "main",
    expectedRevision: null,
    operationId: "strict-1",
    payload: bytes("one"),
  });
  const compacted = await store.compact({
    scope,
    branchId: "main",
    expectedRevision: first.branch.revision,
    operationId: "strict-compact",
    snapshot: bytes("snapshot"),
  });

  const inheritedView = Object.assign(Object.create({ view: "history" }), {
    scope,
    recordId: compacted.record.id,
  });
  await assert.rejects(
    store.path(inheritedView),
    /cave_session_input_invalid:path/,
  );

  let reads = 0;
  const accessorView = { scope, recordId: compacted.record.id };
  Object.defineProperty(accessorView, "view", {
    enumerable: true,
    get() {
      reads++;
      return "history";
    },
  });
  await assert.rejects(
    store.path(accessorView),
    /cave_session_input_invalid:path/,
  );
  assert.equal(reads, 0);

  const accessorOptions = {};
  Object.defineProperty(accessorOptions, "maxPayloadBytes", {
    enumerable: true,
    get() {
      reads++;
      return 1;
    },
  });
  assert.throws(
    () => new MemorySessionStore(accessorOptions),
    /cave_session_options_invalid/,
  );
  assert.equal(reads, 0);
});

test("scope isolation, exact shapes, and explicit limits fail closed", async () => {
  const store = new MemorySessionStore({
    maxPayloadBytes: 3,
    maxRecordsPerScope: 1,
    maxBranchesPerScope: 1,
  });
  await assert.rejects(store.append({
    scope,
    branchId: "main",
    expectedRevision: null,
    operationId: "large",
    payload: bytes("four"),
  }), /cave_session_payload_too_large/);

  const first = await store.append({
    scope,
    branchId: "main",
    expectedRevision: null,
    operationId: "run-1",
    payload: bytes("one"),
  });
  await assert.rejects(store.append({
    scope,
    branchId: "main",
    expectedRevision: first.branch.revision,
    operationId: "run-2",
    payload: bytes("two"),
  }), /cave_session_capacity_exceeded:records/);
  await assert.rejects(store.fork({
    scope,
    sourceRecordId: first.record.id,
    targetBranchId: "alternate",
    operationId: "fork-1",
  }), /cave_session_capacity_exceeded:branches/);

  const otherScope = { tenant: "tenant-2", sessionId: "session-1" };
  assert.equal(await store.load({ scope: otherScope, branchId: "main" }), null);
  await assert.rejects(
    store.path({ scope: otherScope, recordId: first.record.id }),
    /cave_session_record_not_found/,
  );
  await assert.rejects(
    store.load({ scope, branchId: "main", extra: true }),
    /cave_session_input_invalid:load/,
  );

  const byteBounded = new MemorySessionStore({
    maxPayloadBytes: 3,
    maxTotalPayloadBytesPerScope: 3,
  });
  const boundedFirst = await byteBounded.append({
    scope,
    branchId: "main",
    expectedRevision: null,
    operationId: "bounded-1",
    payload: bytes("one"),
  });
  await assert.rejects(byteBounded.append({
    scope,
    branchId: "main",
    expectedRevision: boundedFirst.branch.revision,
    operationId: "bounded-2",
    payload: bytes("x"),
  }), /cave_session_capacity_exceeded:payload_bytes/);
});

test("rejected mutations allocate no scope and store-wide limits are explicit", async () => {
  const rejectedForkStore = new MemorySessionStore({ maxScopes: 1 });
  await assert.rejects(rejectedForkStore.fork({
    scope: { tenant: "rejected", sessionId: "missing" },
    sourceRecordId: "record-missing",
    targetBranchId: "branch-missing",
    operationId: "fork-missing",
  }), /cave_session_record_not_found/);
  await rejectedForkStore.append({
    scope,
    branchId: "main",
    expectedRevision: null,
    operationId: "accepted-after-rejection",
    payload: bytes("ok"),
  });

  const rejectedCasStore = new MemorySessionStore({ maxScopes: 1 });
  await assert.rejects(rejectedCasStore.append({
    scope: { tenant: "rejected", sessionId: "conflict" },
    branchId: "main",
    expectedRevision: "revision-does-not-exist",
    operationId: "rejected-cas",
    payload: bytes("no"),
  }), SessionConflictError);
  await rejectedCasStore.append({
    scope,
    branchId: "main",
    expectedRevision: null,
    operationId: "accepted-after-conflict",
    payload: bytes("ok"),
  });

  const globalStore = new MemorySessionStore({
    maxPayloadBytes: 2,
    maxTotalPayloadBytesPerScope: 2,
    maxTotalPayloadBytes: 3,
    maxRecordsPerScope: 2,
    maxTotalRecords: 2,
    maxBranchesPerScope: 2,
    maxTotalBranches: 2,
    maxScopes: 2,
  });
  await globalStore.append({
    scope: { tenant: "tenant-a", sessionId: "session-a" },
    branchId: "main",
    expectedRevision: null,
    operationId: "global-1",
    payload: bytes("aa"),
  });
  await assert.rejects(globalStore.append({
    scope: { tenant: "tenant-b", sessionId: "session-b" },
    branchId: "main",
    expectedRevision: null,
    operationId: "global-2",
    payload: bytes("bb"),
  }), /cave_session_capacity_exceeded:total_payload_bytes/);
});
