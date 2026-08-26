import test from "node:test";
import assert from "node:assert/strict";

import {
  ALL_EVENT_KINDS,
  isStopReason,
  isTurnEvent,
  isUsage,
  type EnvelopeFields,
  type TurnEventKind,
} from "../src/events.ts";

const envelope: EnvelopeFields = {
  v: 1,
  seq: 3,
  ts: "2026-08-25T09:30:00.000Z",
  sessionId: "sess_test",
};

/** One valid synthesized example per kind (beyond the golden fixtures). */
function validEvent(kind: TurnEventKind): Record<string, unknown> {
  const base = { ...envelope, kind };
  switch (kind) {
    case "turn.start":
      return base;
    case "turn.end":
      return { ...base, stopReason: "end_turn" };
    case "delta.text":
      return { ...base, text: "hello" };
    case "delta.thinking":
      return { ...base, text: "hmm" };
    case "tool.start":
      return { ...base, id: "t1", name: "bash", argsSummary: "" };
    case "tool.update":
      return { ...base, id: "t1", delta: "..." };
    case "tool.end":
      return { ...base, id: "t1", status: "completed" };
    case "usage":
      return {
        ...base,
        usage: {
          in: 1,
          out: 2,
          cacheRead: 3,
          cacheWrite: 4,
          costUsd: null,
          model: "test-model",
        },
      };
    case "stage.open":
      return { ...base, id: "s1", label: "Stage" };
    case "stage.rewrite":
      return { ...base, id: "s1", label: "Stage v2" };
    case "stage.close":
      return { ...base, id: "s1" };
    case "error":
      return { ...base, message: "boom", retryable: false };
    case "permission.request":
      return { ...base, id: "p1", tool: "bash", plainLanguage: "Run it?" };
    case "permission.resolve":
      return { ...base, id: "p1", decision: "deny" };
    case "queue.changed":
      return { ...base, queued: 0, heldAfterInterrupt: false };
    case "checkpoint.created":
      return { ...base, ref: "cpg_x", n: 0 };
    case "route.decided":
      return { ...base, model: "m", reason: "r", signals: [] };
    case "budget.stopped":
      return {
        ...base,
        estimateUsd: 0.01,
        leftUsd: 0,
        message: "Stopped — over budget.",
      };
    case "session.compacting":
      return base;
  }
}

test("every kind has a valid example that passes", () => {
  for (const kind of ALL_EVENT_KINDS) {
    assert.ok(isTurnEvent(validEvent(kind)), `${kind} should validate`);
  }
});

test("ALL_EVENT_KINDS has no duplicates", () => {
  assert.equal(new Set(ALL_EVENT_KINDS).size, ALL_EVENT_KINDS.length);
});

test("isStopReason accepts exactly the six frozen values", () => {
  for (const r of [
    "end_turn",
    "awaiting_input",
    "awaiting_approval",
    "budget_paused",
    "interrupted",
    "error",
  ]) {
    assert.ok(isStopReason(r), r);
  }
  for (const bad of ["complete", "done", "END_TURN", "", null, 1]) {
    assert.ok(!isStopReason(bad), String(bad));
  }
});

test("isUsage: priced and unpriced both valid; garbage fails closed", () => {
  const priced = {
    in: 10,
    out: 20,
    cacheRead: 30,
    cacheWrite: 40,
    costUsd: 0.5,
    model: "m",
  };
  const unpriced = { ...priced, costUsd: null };
  assert.ok(isUsage(priced) && isUsage(unpriced));

  // costUsd:null means UNKNOWN — never zero — and stays distinct from 0:
  assert.ok(isUsage({ ...priced, costUsd: 0 }));

  const invalids = [
    { ...priced, in: -1 },
    { ...priced, in: 1.5 },
    { ...priced, in: NaN },
    { ...priced, costUsd: Infinity },
    { ...priced, costUsd: NaN },
    { ...priced, model: "" },
    { ...priced, model: undefined },
    { ...priced, out: "20" },
    {},
    null,
    [],
  ];
  for (const bad of invalids) assert.ok(!isUsage(bad), JSON.stringify(bad));
});

function reject(label: string, mutate: (e: Record<string, unknown>) => unknown): void {
  const e = validEvent("delta.text") as Record<string, unknown>;
  assert.ok(!isTurnEvent(mutate(e)), label);
}

test("envelope violations fail closed", () => {
  reject("v as string", (e) => ({ ...e, v: "1" }));
  reject("v bumped", (e) => ({ ...e, v: 2 }));
  reject("v missing", ({ v, ...rest }) => rest);
  reject("negative seq", (e) => ({ ...e, seq: -1 }));
  reject("fractional seq", (e) => ({ ...e, seq: 0.5 }));
  reject("date-only ts", (e) => ({ ...e, ts: "2026-08-25" }));
  reject("ts without T", (e) => ({ ...e, ts: "2026-08-25 09:30:00Z" }));
  reject("ts without timezone", (e) => ({ ...e, ts: "2026-08-25T09:30:00" }));
  reject("empty sessionId", (e) => ({ ...e, sessionId: "" }));
  reject("sessionId missing", ({ sessionId, ...rest }) => rest);
  reject("array not object", () => []);
  reject("null", () => null);
  reject("string", () => "turn.start");
});

test("payload violations fail closed per kind", () => {
  // turn.end
  assert.ok(!isTurnEvent({ ...validEvent("turn.end"), stopReason: "complete" }));
  assert.ok(!isTurnEvent({ ...validEvent("turn.end"), stopReason: undefined }));

  // error: retryable must be LITERALLY false — post-retry-only producer contract
  const err = validEvent("error");
  assert.ok(!isTurnEvent({ ...err, retryable: true }));
  assert.ok(!isTurnEvent({ ...err, retryable: "false" }));
  assert.ok(isTurnEvent(err));

  // permission.resolve decisions are a closed vocabulary
  assert.ok(
    !isTurnEvent({ ...validEvent("permission.resolve"), decision: "always" }),
  );
  for (const d of ["allow-once", "allow-session", "deny"]) {
    assert.ok(isTurnEvent({ ...validEvent("permission.resolve"), decision: d }));
  }

  // tool.end outcomes closed; optional detail must be a string when present
  assert.ok(!isTurnEvent({ ...validEvent("tool.end"), status: "ok" }));
  assert.ok(!isTurnEvent({ ...validEvent("tool.end"), detail: 7 }));
  assert.ok(isTurnEvent({ ...validEvent("tool.end"), detail: "why" }));
  assert.ok(!isTurnEvent({ ...validEvent("tool.end"), id: "" }));

  // usage event requires a full Usage object
  assert.ok(!isTurnEvent({ ...validEvent("usage"), usage: null }));
  assert.ok(!isTurnEvent({ ...validEvent("usage"), usage: { in: 1 } }));

  // queue.changed booleans are strict
  assert.ok(
    !isTurnEvent({ ...validEvent("queue.changed"), heldAfterInterrupt: "yes" }),
  );
  assert.ok(!isTurnEvent({ ...validEvent("queue.changed"), queued: 1.2 }));

  // route.decided signals must all be non-empty strings
  assert.ok(!isTurnEvent({ ...validEvent("route.decided"), signals: [1] }));
  assert.ok(!isTurnEvent({ ...validEvent("route.decided"), signals: [""] }));
  assert.ok(!isTurnEvent({ ...validEvent("route.decided"), signals: "x" }));

  // budget.stopped amounts fail closed on NaN / negative
  assert.ok(!isTurnEvent({ ...validEvent("budget.stopped"), leftUsd: NaN }));
  assert.ok(!isTurnEvent({ ...validEvent("budget.stopped"), estimateUsd: -1 }));

  // stage labels and ids non-empty
  assert.ok(!isTurnEvent({ ...validEvent("stage.open"), label: "" }));
  assert.ok(!isTurnEvent({ ...validEvent("stage.close"), id: "" }));

  // checkpoint n is a count
  assert.ok(!isTurnEvent({ ...validEvent("checkpoint.created"), n: -3 }));
});

test("unknown extra properties are tolerated (additive-minor policy)", () => {
  const e = validEvent("turn.start") as Record<string, unknown>;
  assert.ok(isTurnEvent({ ...e, futureField: { nested: true } }));
});

test("unknown kinds are rejected, not guessed", () => {
  const e = validEvent("turn.start") as Record<string, unknown>;
  assert.ok(!isTurnEvent({ ...e, kind: "turn.restart" }));
  assert.ok(!isTurnEvent({ ...e, kind: 42 }));
});
