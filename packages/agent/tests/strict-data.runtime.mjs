import assert from "node:assert/strict";
import test from "node:test";

import {
  snapshotDataDictionary,
  snapshotDataRecord,
  snapshotDenseArray,
} from "../dist/strict-data.js";

function invalid() {
  throw new Error("cave_strict_data_invalid");
}

test("records reject accessors without ever invoking them", () => {
  let reads = 0;
  const value = { id: "probe" };
  Object.defineProperty(value, "mode", {
    enumerable: true,
    get() {
      reads++;
      return "live";
    },
  });
  assert.throws(() => snapshotDataRecord(value, ["id", "mode"], ["id"], invalid));
  assert.equal(reads, 0);
});

test("records take own data only and detach from the source", () => {
  Object.defineProperty(Object.prototype, "inherited", {
    configurable: true,
    enumerable: true,
    value: "from-prototype",
  });
  try {
    const source = { id: "probe" };
    const snapshot = snapshotDataRecord(source, ["id"], ["id"], invalid);
    assert.equal(Object.hasOwn(snapshot, "inherited"), false);
    assert.equal(Object.getPrototypeOf(snapshot), null);
    source.id = "mutated";
    assert.equal(snapshot.id, "probe");
  } finally {
    delete Object.prototype.inherited;
  }
  assert.throws(() => snapshotDataRecord({ id: "a", extra: 1 }, ["id"], ["id"], invalid));
  assert.throws(() => snapshotDataRecord({}, ["id"], ["id"], invalid));
});

test("dictionaries fail closed above the caller-declared key budget", () => {
  assert.deepEqual({ ...snapshotDataDictionary({ a: 1, b: 2 }, 2, invalid) }, { a: 1, b: 2 });
  assert.throws(() => snapshotDataDictionary({ a: 1, b: 2 }, 1, invalid));
});

test("arrays reject holes, oversize, and non-array objects", () => {
  assert.deepEqual(snapshotDenseArray([1, 2], 2, invalid), [1, 2]);
  assert.throws(() => snapshotDenseArray(new Array(1), 4, invalid));
  assert.throws(() => snapshotDenseArray([1, 2, 3], 2, invalid));
  assert.throws(() => snapshotDenseArray({ length: 0 }, 4, invalid));
});
