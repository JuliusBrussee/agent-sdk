import { writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Regenerates all golden fixtures deterministically. Run from package root:
 *   node scripts/regenerate-fixtures.mjs
 * Fixtures are COMMITTED artifacts; this script exists so future edits keep
 * the canonical key order / compact serialization / coherent session intact.
 */

const SESSION_ID = "sess_01J9Z8Q4VHN7X2";

// [kind, seq, ts, payload-fields]
const FIXTURES = [
  ["turn.start", 0, "09:30:00.000", {}],
  ["route.decided", 1, "09:30:01.556", {
    model: "claude-opus-4-6",
    reason: "cache prefix matches open session; cold start avoided",
    signals: ["cache-prefix-match", "budget-headroom"],
  }],
  ["delta.thinking", 2, "09:30:02.118", {
    text: "The failing test points at cache-key drift; check the epoch boundary before touching the planner.",
  }],
  ["tool.start", 3, "09:30:03.402", {
    id: "call_01J9Z8QG5M",
    name: "edit_file",
    argsSummary: "src/cache/planner.ts (+12 −4)",
  }],
  ["stage.open", 4, "09:30:04.001", { id: "stg_1", label: "Reproduce the failure" }],
  ["tool.update", 5, "09:30:12.870", {
    id: "call_01J9Z8QN2F",
    delta: "ok 42 - cache-prefix-parity\n",
  }],
  ["tool.end", 6, "09:30:13.091", {
    id: "call_01J9Z8QN2F",
    status: "completed",
    detail: "47 tests, 0 failures",
  }],
  ["stage.rewrite", 7, "09:30:20.777", { id: "stg_1", label: "Reproduce + pin the drift" }],
  ["stage.close", 8, "09:30:21.340", { id: "stg_1" }],
  ["session.compacting", 9, "09:30:24.500", { firstKeptEntryId: "ent_0042" }],
  ["queue.changed", 10, "09:30:27.503", { queued: 2, heldAfterInterrupt: true }],
  ["checkpoint.created", 11, "09:30:29.118", { ref: "cpg_7f3a91b2", n: 14 }],
  ["usage", 12, "09:30:30.220", {
    usage: {
      in: 1234,
      out: 567,
      cacheRead: 8901,
      cacheWrite: 234,
      costUsd: 0.0042,
      model: "claude-opus-4-6",
    },
  }],
  ["permission.request", 13, "09:30:31.008", {
    id: "perm_01J9Z8R3T",
    tool: "bash",
    plainLanguage: "Delete ./build to clear stale artifacts before the release check.",
    detail: "bash -lc 'rm -rf ./build'",
  }],
  ["permission.resolve", 14, "09:30:31.944", { id: "perm_01J9Z8R3T", decision: "allow-once" }],
  ["budget.stopped", 15, "09:30:33.201", {
    estimateUsd: 0.0412,
    leftUsd: 0.0018,
    message: "Stopped — over budget.",
  }],
  // U+2028/U+2029 are emitted RAW by JSON.stringify inside string values —
  // this fixture is the standing proof that framing survives them.
  ["delta.text", 16, "09:30:40.997", {
    text: "Done — 12 files touched. \u2028 See the stage summary above. \u2029 All checks pass, cost on /usage.",
  }],
  ["error", 17, "09:30:38.615", {
    message: "provider 500s persisted past the retry window",
    retryable: false,
  }],
  ["turn.end", 18, "09:30:41.512", { stopReason: "end_turn" }],
];

for (const [kind, seq, time, fields] of FIXTURES) {
  const event = {
    v: 1,
    seq,
    ts: `2026-08-25T${time}Z`,
    sessionId: SESSION_ID,
    kind,
    ...fields,
  };
  writeFileSync(join("fixtures", `${kind}.json`), JSON.stringify(event) + "\n");
}
console.log(`wrote ${FIXTURES.length} fixtures`);
