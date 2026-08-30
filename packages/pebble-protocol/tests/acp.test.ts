import test from "node:test";
import assert from "node:assert/strict";

import { ALL_EVENT_KINDS, type TurnEventKind } from "../src/events.ts";
import {
  ACP_MAPPING,
  ACP_METHODS,
  ACP_STOP_REASONS,
  ACP_UPDATE_VARIANTS,
  acpRowFor,
  STOP_REASON_TO_ACP,
  TOOL_OUTCOME_TO_ACP_STATUS,
} from "../src/acp.ts";
import {
  STOP_REASONS,
  TOOL_OUTCOMES,
} from "../src/events.ts";

test("mapping table is exhaustive over ALL_EVENT_KINDS with zero extras", () => {
  const tableKinds = Object.keys(ACP_MAPPING).sort();
  const expected = [...ALL_EVENT_KINDS].sort();
  assert.deepEqual(tableKinds, expected);
});

test("every row is well-formed: known methods/updates, non-empty notes", () => {
  for (const kind of ALL_EVENT_KINDS as readonly TurnEventKind[]) {
    const row = acpRowFor(kind);
    assert.equal(row.pebbleKind, kind);
    assert.equal(typeof row.notes, "string");
    assert.ok(row.notes.length > 0, `${kind}: notes required`);
    if (row.acpMethod !== null) {
      assert.ok(
        (ACP_METHODS as readonly string[]).includes(row.acpMethod),
        `${kind}: unknown method ${row.acpMethod}`,
      );
    }
    if (row.acpUpdate !== null) {
      assert.ok(
        (ACP_UPDATE_VARIANTS as readonly string[]).includes(row.acpUpdate),
        `${kind}: unknown update variant ${row.acpUpdate}`,
      );
      assert.equal(row.acpMethod, "session/update", `${kind}: updates ride session/update`);
    }
  }
});

test("stop-reason mapping is total over the frozen enum and stays in ACP's set", () => {
  assert.deepEqual(Object.keys(STOP_REASON_TO_ACP).sort(), [...STOP_REASONS].sort());
  for (const stopReason of STOP_REASONS) {
    assert.ok(
      (ACP_STOP_REASONS as readonly string[]).includes(STOP_REASON_TO_ACP[stopReason]),
      stopReason,
    );
  }
});

test("legacy permission frames have no ACP operation", () => {
  assert.equal(acpRowFor("permission.request").acpMethod, null);
  assert.equal(acpRowFor("permission.resolve").acpMethod, null);
  assert.ok(!ACP_METHODS.includes("session/request_permission"));
});

test("tool outcome mapping is total; cancellation is client-owned in ACP", () => {
  assert.deepEqual(Object.keys(TOOL_OUTCOME_TO_ACP_STATUS).sort(), [
    ...TOOL_OUTCOMES,
  ].sort());
  assert.equal(TOOL_OUTCOME_TO_ACP_STATUS.completed, "completed");
  assert.equal(TOOL_OUTCOME_TO_ACP_STATUS.failed, "failed");
  // ACP reserves "cancelled" for clients — agents emit no status at all.
  assert.equal(TOOL_OUTCOME_TO_ACP_STATUS.cancelled, null);
});
