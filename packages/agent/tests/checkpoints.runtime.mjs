import assert from "node:assert/strict";
import test from "node:test";

import {
  compareCheckpoints,
  restoreCheckpoint,
} from "../dist/checkpoints.js";

const digest = `sha256:${"a".repeat(64)}`;
const timestamp = "2026-08-30T10:00:00.000Z";
const runtime = Object.freeze({
  schemaVersion: 1,
  backend: Object.freeze({ id: "fixture" }),
  containment: "unknown",
  filesystem: Object.freeze({ read: "unknown", write: "unknown" }),
  network: "unknown",
  subprocess: "unknown",
  limits: Object.freeze({
    deadline: "unknown",
    outputBytes: "unknown",
    memory: "unknown",
    cpu: "unknown",
  }),
  evidence: Object.freeze({ basis: "backend_contract" }),
});

function restoreEvidence() {
  return {
    ref: "checkpoint-1",
    restoredAt: timestamp,
    beforeRootDigest: digest,
    afterRootDigest: digest,
    changedPathCount: 1,
    runtime,
  };
}

function restoreRequest(signal) {
  return {
    sessionId: "session-1",
    ref: "checkpoint-1",
    expectedRootDigest: digest,
    signal,
  };
}

test("restore abort waits for a noncooperative mutation to settle", async () => {
  const controller = new AbortController();
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  let mutated = false;
  let outcomeSettled = false;
  const pending = restoreCheckpoint({
    capture() { throw new Error("unused"); },
    async restore() {
      started.resolve();
      await release.promise;
      mutated = true;
      return restoreEvidence();
    },
  }, restoreRequest(controller.signal));
  void pending.then(
    () => { outcomeSettled = true; },
    () => { outcomeSettled = true; },
  );

  await started.promise;
  controller.abort(new Error("caller canceled"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(outcomeSettled, false);
  assert.equal(mutated, false);

  release.resolve();
  await assert.rejects(pending, /cave_checkpoint_aborted/);
  assert.equal(mutated, true);
  assert.equal(outcomeSettled, true);
});

test("restore abort waits for a noncooperative rejection to settle", async () => {
  const controller = new AbortController();
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  let outcomeSettled = false;
  const pending = restoreCheckpoint({
    capture() { throw new Error("unused"); },
    async restore() {
      started.resolve();
      await release.promise;
      throw new Error("late restore failure");
    },
  }, restoreRequest(controller.signal));
  void pending.then(
    () => { outcomeSettled = true; },
    () => { outcomeSettled = true; },
  );

  await started.promise;
  controller.abort(new Error("caller canceled"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(outcomeSettled, false);

  release.resolve();
  await assert.rejects(pending, /cave_checkpoint_aborted/);
  assert.equal(outcomeSettled, true);
});

test("already-aborted restore never starts the effect", async () => {
  const controller = new AbortController();
  controller.abort(new Error("caller canceled"));
  let calls = 0;
  await assert.rejects(restoreCheckpoint({
    capture() { throw new Error("unused"); },
    restore() {
      calls++;
      return restoreEvidence();
    },
  }, restoreRequest(controller.signal)), /cave_checkpoint_aborted/);
  assert.equal(calls, 0);
});

test("abort triggered as restore evidence settles still wins before validation", async () => {
  const controller = new AbortController();
  const rawEvidence = restoreEvidence();
  await assert.rejects(restoreCheckpoint({
    capture() { throw new Error("unused"); },
    restore() {
      controller.abort(new Error("caller canceled"));
      return rawEvidence;
    },
  }, restoreRequest(controller.signal)), /cave_checkpoint_aborted/);
});

test("raw restore failure cannot masquerade as SDK evidence mismatch", async () => {
  await assert.rejects(restoreCheckpoint({
    capture() { throw new Error("unused"); },
    restore() { throw new Error("cave_checkpoint_restore_mismatch"); },
  }, restoreRequest(undefined)), (error) => error.message === "cave_checkpoint_restore_failed");
});

test("checkpoint hooks are captured once without bind or raw getter leakage", async () => {
  const restore = function () { return restoreEvidence(); };
  Object.defineProperty(restore, "bind", {
    configurable: true,
    get() { throw new Error("secret bind detail"); },
  });
  const restored = await restoreCheckpoint({
    capture() { throw new Error("unused"); },
    restore,
  }, restoreRequest(undefined));
  assert.equal(restored.ref, "checkpoint-1");

  const hooks = {
    capture() { throw new Error("unused"); },
  };
  Object.defineProperty(hooks, "restore", {
    enumerable: true,
    get() { throw new Error("secret getter detail"); },
  });
  await assert.rejects(
    restoreCheckpoint(hooks, restoreRequest(undefined)),
    (error) => error.message === "cave_checkpoint_invalid:hooks",
  );
});

test("raw compare failure cannot masquerade as SDK evidence mismatch", async () => {
  await assert.rejects(compareCheckpoints({
    capture() { throw new Error("unused"); },
    restore() { throw new Error("unused"); },
    compare() { throw new Error("cave_checkpoint_compare_mismatch"); },
  }, "checkpoint-1", "checkpoint-2"),
  (error) => error.message === "cave_checkpoint_compare_failed");
});
