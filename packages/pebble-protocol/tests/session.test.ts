import test from "node:test";
import assert from "node:assert/strict";

import { isSessionEntry, type SessionEntry } from "../src/session.ts";

const root: SessionEntry = {
  id: "ent_0001",
  parentId: null,
  role: "user",
  content: "list files",
  ts: "2026-08-25T09:30:00.000Z",
  v: 1,
};

test("root entry with null parent validates", () => {
  assert.ok(isSessionEntry(root));
});

test("child entry with string parent validates", () => {
  const child = {
    ...root,
    id: "ent_0002",
    parentId: "ent_0001",
    role: "assistant" as const,
    content: "",
  };
  assert.ok(isSessionEntry(child));
});

test("all four roles validate, including summary", () => {
  for (const role of ["user", "assistant", "system", "summary"] as const) {
    assert.ok(isSessionEntry({ ...root, role }), role);
  }
});

test("usage optional: absent and present both validate", () => {
  assert.ok(isSessionEntry(root));
  const withUsage = {
    ...root,
    usage: {
      in: 5,
      out: 6,
      cacheRead: 0,
      cacheWrite: 0,
      costUsd: null,
      model: "m",
    },
  };
  assert.ok(isSessionEntry(withUsage));
});

test("violations fail closed", () => {
  // role vocabulary closed
  assert.ok(!isSessionEntry({ ...root, role: "tool" }));
  assert.ok(!isSessionEntry({ ...root, role: undefined }));

  // parentId must be exactly null or a non-empty string
  assert.ok(!isSessionEntry({ ...root, parentId: undefined }));
  assert.ok(!isSessionEntry({ ...root, parentId: "" }));
  assert.ok(!isSessionEntry({ ...root, parentId: 0 }));

  // content must be a string (empty allowed)
  assert.ok(isSessionEntry({ ...root, content: "" }));
  assert.ok(!isSessionEntry({ ...root, content: null }));

  // ids and timestamps strict
  assert.ok(!isSessionEntry({ ...root, id: "" }));
  assert.ok(!isSessionEntry({ ...root, id: undefined }));
  assert.ok(!isSessionEntry({ ...root, ts: "2026-08-25" }));
  assert.ok(!isSessionEntry({ ...root, ts: 1234 }));

  // version pinned to 1
  assert.ok(!isSessionEntry({ ...root, v: 2 }));
  assert.ok(!isSessionEntry({ ...root, v: "1" }));

  // usage must be fully valid when present
  assert.ok(!isSessionEntry({ ...root, usage: { in: 1 } }));
  assert.ok(!isSessionEntry({ ...root, usage: {} }));

  // non-object shapes
  assert.ok(!isSessionEntry(null));
  assert.ok(!isSessionEntry([root]));
  assert.ok(!isSessionEntry("entry"));
});

test("unknown extra properties tolerated (additive-minor policy)", () => {
  assert.ok(isSessionEntry({ ...root, migratedFrom: { v: 0 } }));
});
