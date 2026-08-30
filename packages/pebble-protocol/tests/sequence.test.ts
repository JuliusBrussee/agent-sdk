import test from "node:test";
import assert from "node:assert/strict";

import {
  isTurnEvent,
  type TurnEvent,
} from "../src/events.ts";
import {
  SessionEventSequenceCoordinator,
  TurnEventSequenceError,
  TurnEventSequenceValidator,
  type TurnEventSequenceErrorCode,
} from "../src/sequence.ts";

const TS = "2026-08-30T12:00:00.000Z";

type EventPayload = TurnEvent extends infer Event
  ? Event extends TurnEvent
    ? Omit<Event, "v" | "seq" | "ts" | "sessionId">
    : never
  : never;

function event(
  seq: number,
  payload: EventPayload,
  sessionId = "sess_sequence",
): TurnEvent {
  const candidate = { v: 1, seq, ts: TS, sessionId, ...payload };
  assert.ok(isTurnEvent(candidate), `test event ${payload.kind} must be valid`);
  return candidate;
}

function expectCode(
  code: TurnEventSequenceErrorCode,
  run: () => unknown,
): TurnEventSequenceError {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof TurnEventSequenceError);
  assert.equal(caught.code, code);
  return caught;
}

test("accepts complete turn with interleaved structural lifecycles", () => {
  const validator = new TurnEventSequenceValidator();
  const events = [
    event(0, { kind: "turn.start" }),
    event(1, { kind: "stage.open", id: "s1", label: "Inspect" }),
    event(2, { kind: "tool.start", id: "t1", name: "read", argsSummary: "src" }),
    event(3, { kind: "stage.open", id: "s2", label: "Verify" }),
    event(4, { kind: "tool.start", id: "t2", name: "test", argsSummary: "unit" }),
    event(5, { kind: "permission.request", id: "p1", tool: "bash", plainLanguage: "Run test?" }),
    event(6, { kind: "tool.update", id: "t1", delta: "halfway" }),
    event(7, { kind: "stage.rewrite", id: "s1", label: "Inspect source" }),
    event(8, { kind: "permission.resolve", id: "p1", decision: "allow-once" }),
    event(9, { kind: "tool.end", id: "t2", status: "completed" }),
    event(10, { kind: "stage.close", id: "s2" }),
    event(11, { kind: "tool.end", id: "t1", status: "completed" }),
    event(12, { kind: "stage.close", id: "s1" }),
    event(13, { kind: "delta.text", text: "done" }),
    event(14, { kind: "turn.end", stopReason: "end_turn" }),
  ];

  for (const item of events) {
    const accepted = validator.push(item);
    assert.deepEqual(accepted, item);
    assert.notEqual(accepted, item);
    assert.equal(Object.isFrozen(accepted), true);
  }
  assert.equal(validator.openLifecycleCount, 0);
  assert.equal(validator.nextSeq, 15);

  const summary = validator.finish();
  assert.deepEqual(summary, {
    sessionId: "sess_sequence",
    firstSeq: 0,
    lastSeq: 14,
    eventCount: 15,
    stopReason: "end_turn",
    errorEventSeen: false,
    peakOpenLifecycles: 4,
  });
  assert.equal(validator.end(), summary, "finish/end are idempotent");
  assert.equal(validator.finished, true);
});

test("supports later session turn through explicit firstSeq and session identity", () => {
  const validator = new TurnEventSequenceValidator({
    firstSeq: 41,
    sessionId: "sess_later",
  });
  validator.push(event(41, { kind: "turn.start" }, "sess_later"));
  validator.push(event(42, { kind: "turn.end", stopReason: "interrupted" }, "sess_later"));
  assert.deepEqual(validator.end(), {
    sessionId: "sess_later",
    firstSeq: 41,
    lastSeq: 42,
    eventCount: 2,
    stopReason: "interrupted",
    errorEventSeen: false,
    peakOpenLifecycles: 0,
  });
});

test("session coordinator folds contiguous turns into bounded frozen evidence", () => {
  const coordinator = new SessionEventSequenceCoordinator();
  const originalStart = event(0, { kind: "turn.start" }, "sess_coordinator");
  const acceptedStart = coordinator.push(originalStart);
  assert.notEqual(acceptedStart, originalStart);
  assert.equal(Object.isFrozen(acceptedStart), true);
  (originalStart as { sessionId: string }).sessionId = "forged";

  coordinator.push(event(1, {
    kind: "tool.start",
    id: "tool-one",
    name: "read",
    argsSummary: "src",
  }, "sess_coordinator"));
  coordinator.push(event(2, {
    kind: "tool.end",
    id: "tool-one",
    status: "completed",
  }, "sess_coordinator"));
  coordinator.push(event(3, {
    kind: "turn.end",
    stopReason: "end_turn",
  }, "sess_coordinator"));

  assert.deepEqual(coordinator.latestTurnSummary, {
    sessionId: "sess_coordinator",
    firstSeq: 0,
    lastSeq: 3,
    eventCount: 4,
    stopReason: "end_turn",
    errorEventSeen: false,
    peakOpenLifecycles: 1,
  });
  assert.equal(Object.isFrozen(coordinator.latestTurnSummary), true);

  coordinator.push(event(4, { kind: "turn.start" }, "sess_coordinator"));
  coordinator.push(event(5, { kind: "delta.text", text: "done" }, "sess_coordinator"));
  coordinator.push(event(6, {
    kind: "turn.end",
    stopReason: "awaiting_input",
  }, "sess_coordinator"));

  const summary = coordinator.finish();
  assert.deepEqual(summary, {
    sessionId: "sess_coordinator",
    firstSeq: 0,
    lastSeq: 6,
    eventCount: 7,
    turnCount: 2,
    toolCallCount: 1,
    peakOpenLifecycles: 1,
  });
  assert.equal(Object.isFrozen(summary), true);
  assert.equal(coordinator.end(), summary);
  assert.equal(coordinator.nextSeq, 7);
  assert.equal(coordinator.finished, true);
});

test("session coordinator rejects cross-turn tool id reuse and stays poisoned", () => {
  const coordinator = new SessionEventSequenceCoordinator();
  coordinator.push(event(0, { kind: "turn.start" }));
  coordinator.push(event(1, {
    kind: "tool.start",
    id: "shared",
    name: "read",
    argsSummary: "",
  }));
  coordinator.push(event(2, {
    kind: "tool.end",
    id: "shared",
    status: "completed",
  }));
  coordinator.push(event(3, { kind: "turn.end", stopReason: "end_turn" }));
  coordinator.push(event(4, { kind: "turn.start" }));
  const first = expectCode("pebble_sequence_lifecycle_duplicate", () => {
    coordinator.push(event(5, {
      kind: "tool.start",
      id: "shared",
      name: "write",
      argsSummary: "",
    }));
  });
  let second: unknown;
  try {
    coordinator.push(event(6, { kind: "turn.end", stopReason: "end_turn" }));
  } catch (error) {
    second = error;
  }
  assert.equal(second, first);
});

test("session coordinator enforces one session and gap-free turn boundaries", () => {
  const gap = new SessionEventSequenceCoordinator();
  gap.push(event(0, { kind: "turn.start" }));
  gap.push(event(1, { kind: "turn.end", stopReason: "end_turn" }));
  const gapError = expectCode("pebble_sequence_number_mismatch", () => {
    gap.push(event(3, { kind: "turn.start" }));
  });
  let repeatedGapError: unknown;
  try {
    gap.push(event(2, { kind: "turn.start" }));
  } catch (error) {
    repeatedGapError = error;
  }
  assert.equal(repeatedGapError, gapError, "delegated turn failure poisons session");

  const wrongKind = new SessionEventSequenceCoordinator();
  wrongKind.push(event(0, { kind: "turn.start" }));
  wrongKind.push(event(1, { kind: "turn.end", stopReason: "end_turn" }));
  expectCode("pebble_sequence_turn_start_required", () => {
    wrongKind.push(event(2, { kind: "delta.text", text: "between turns" }));
  });

  const session = new SessionEventSequenceCoordinator();
  session.push(event(0, { kind: "turn.start" }, "one"));
  session.push(event(1, { kind: "turn.end", stopReason: "end_turn" }, "one"));
  expectCode("pebble_sequence_session_mismatch", () => {
    session.push(event(2, { kind: "turn.start" }, "two"));
  });
});

test("session coordinator bounds retained tool identities across closed turns", () => {
  const countBounded = new SessionEventSequenceCoordinator({
    maxSeenToolCallIds: 1,
  });
  countBounded.push(event(0, { kind: "turn.start" }));
  countBounded.push(event(1, {
    kind: "tool.start",
    id: "one",
    name: "read",
    argsSummary: "",
  }));
  countBounded.push(event(2, {
    kind: "tool.end",
    id: "one",
    status: "completed",
  }));
  countBounded.push(event(3, { kind: "turn.end", stopReason: "end_turn" }));
  countBounded.push(event(4, { kind: "turn.start" }));
  expectCode("pebble_sequence_seen_limit", () => {
    countBounded.push(event(5, {
      kind: "tool.start",
      id: "two",
      name: "write",
      argsSummary: "",
    }));
  });

  const byteBounded = new SessionEventSequenceCoordinator({
    sessionId: "s",
    maxRetainedIdentityBytes: 3,
  });
  byteBounded.push(event(0, { kind: "turn.start" }, "s"));
  byteBounded.push(event(1, {
    kind: "tool.start",
    id: "aa",
    name: "read",
    argsSummary: "",
  }, "s"));
  byteBounded.push(event(2, {
    kind: "tool.end",
    id: "aa",
    status: "completed",
  }, "s"));
  byteBounded.push(event(3, { kind: "turn.end", stopReason: "end_turn" }, "s"));
  byteBounded.push(event(4, { kind: "turn.start" }, "s"));
  expectCode("pebble_sequence_identity_bytes_limit", () => {
    byteBounded.push(event(5, {
      kind: "tool.start",
      id: "b",
      name: "write",
      argsSummary: "",
    }, "s"));
  });
});

test("session coordinator keeps legacy permission fields opaque and stateless", () => {
  const coordinator = new SessionEventSequenceCoordinator();
  coordinator.push(event(0, { kind: "turn.start" }));
  coordinator.push(event(1, {
    kind: "permission.request",
    id: "opaque",
    tool: "legacy",
    plainLanguage: "opaque compatibility data",
  }));
  coordinator.push(event(2, { kind: "turn.end", stopReason: "end_turn" }));
  coordinator.push(event(3, { kind: "turn.start" }));
  coordinator.push(event(4, {
    kind: "permission.resolve",
    id: "opaque",
    decision: "deny",
  }));
  coordinator.push(event(5, {
    kind: "permission.request",
    id: "opaque",
    tool: "legacy",
    plainLanguage: "still opaque",
  }));
  coordinator.push(event(6, { kind: "turn.end", stopReason: "end_turn" }));
  assert.equal(coordinator.finish().turnCount, 2);
  assert.equal(coordinator.seenToolCallIdCount, 0);
});

test("accepts exactly one terminal error followed immediately by matching turn.end", () => {
  const validator = new TurnEventSequenceValidator();
  validator.push(event(0, { kind: "turn.start" }));
  validator.push(event(1, { kind: "error", message: "settled", retryable: false }));
  validator.push(event(2, { kind: "turn.end", stopReason: "error" }));
  assert.deepEqual(validator.finish(), {
    sessionId: "sess_sequence",
    firstSeq: 0,
    lastSeq: 2,
    eventCount: 3,
    stopReason: "error",
    errorEventSeen: true,
    peakOpenLifecycles: 0,
  });
});

test("unknown or malformed events fail closed and poison validator", () => {
  const validator = new TurnEventSequenceValidator();
  const first = expectCode("pebble_sequence_invalid_event", () => {
    validator.push({ kind: "turn.start", v: 1, seq: 0 });
  });
  let second: unknown;
  try {
    validator.push(event(0, { kind: "turn.start" }));
  } catch (error) {
    second = error;
  }
  assert.equal(second, first, "failure cannot be caught to silently resync");
});

test("sequence must be contiguous and session identity cannot change", () => {
  const gap = new TurnEventSequenceValidator();
  gap.push(event(0, { kind: "turn.start" }));
  const gapError = expectCode("pebble_sequence_number_mismatch", () => {
    gap.push(event(2, { kind: "delta.text", text: "jump" }));
  });
  assert.equal(gapError.seq, 2);
  assert.equal(gapError.eventKind, "delta.text");

  const origin = new TurnEventSequenceValidator();
  expectCode("pebble_sequence_number_mismatch", () => {
    origin.push(event(1, { kind: "turn.start" }));
  });

  const session = new TurnEventSequenceValidator();
  session.push(event(0, { kind: "turn.start" }, "one"));
  expectCode("pebble_sequence_session_mismatch", () => {
    session.push(event(1, { kind: "delta.text", text: "wrong" }, "two"));
  });
});

test("one turn.start is required and duplicate starts fail", () => {
  const missing = new TurnEventSequenceValidator();
  expectCode("pebble_sequence_turn_start_required", () => {
    missing.push(event(0, { kind: "delta.text", text: "early" }));
  });

  const duplicate = new TurnEventSequenceValidator();
  duplicate.push(event(0, { kind: "turn.start" }));
  expectCode("pebble_sequence_turn_start_duplicate", () => {
    duplicate.push(event(1, { kind: "turn.start" }));
  });
});

test("stage rewrite/close require open stage and duplicate opens fail", () => {
  for (const payload of [
    { kind: "stage.rewrite", id: "s", label: "new" } as const,
    { kind: "stage.close", id: "s" } as const,
  ]) {
    const validator = new TurnEventSequenceValidator();
    validator.push(event(0, { kind: "turn.start" }));
    expectCode("pebble_sequence_lifecycle_not_open", () => {
      validator.push(event(1, payload));
    });
  }

  const duplicate = new TurnEventSequenceValidator();
  duplicate.push(event(0, { kind: "turn.start" }));
  duplicate.push(event(1, { kind: "stage.open", id: "s", label: "one" }));
  expectCode("pebble_sequence_lifecycle_duplicate", () => {
    duplicate.push(event(2, { kind: "stage.open", id: "s", label: "two" }));
  });
});

test("tool update/end require open tool and duplicate starts fail", () => {
  for (const payload of [
    { kind: "tool.update", id: "t", delta: "x" } as const,
    { kind: "tool.end", id: "t", status: "completed" } as const,
  ]) {
    const validator = new TurnEventSequenceValidator();
    validator.push(event(0, { kind: "turn.start" }));
    expectCode("pebble_sequence_lifecycle_not_open", () => {
      validator.push(event(1, payload));
    });
  }

  const duplicate = new TurnEventSequenceValidator();
  duplicate.push(event(0, { kind: "turn.start" }));
  duplicate.push(event(1, { kind: "tool.start", id: "t", name: "read", argsSummary: "" }));
  expectCode("pebble_sequence_lifecycle_duplicate", () => {
    duplicate.push(event(2, { kind: "tool.start", id: "t", name: "read", argsSummary: "" }));
  });
});

test("legacy permission events remain schema-only compatibility data", () => {
  const requestTurn = new TurnEventSequenceValidator();
  requestTurn.push(event(0, { kind: "turn.start" }));
  requestTurn.push(event(1, {
    kind: "permission.request",
    id: "p",
    tool: "bash",
    plainLanguage: "Run?",
  }));
  requestTurn.push(event(2, { kind: "turn.end", stopReason: "awaiting_approval" }));
  assert.equal(requestTurn.finish().stopReason, "awaiting_approval");
  assert.equal(requestTurn.seenLifecycleIdCount, 0);

  const laterTurn = new TurnEventSequenceValidator({ firstSeq: 3 });
  laterTurn.push(event(3, { kind: "turn.start" }));
  laterTurn.push(event(4, { kind: "permission.resolve", id: "p", decision: "deny" }));
  laterTurn.push(event(5, { kind: "turn.end", stopReason: "end_turn" }));
  assert.equal(laterTurn.finish().stopReason, "end_turn");
});

test("open lifecycle memory is capped and released on close", () => {
  const capped = new TurnEventSequenceValidator({ maxOpenLifecycles: 2 });
  capped.push(event(0, { kind: "turn.start" }));
  capped.push(event(1, { kind: "stage.open", id: "s", label: "one" }));
  capped.push(event(2, { kind: "tool.start", id: "t", name: "read", argsSummary: "" }));
  expectCode("pebble_sequence_open_limit", () => {
    capped.push(event(3, { kind: "stage.open", id: "s2", label: "two" }));
  });

  const released = new TurnEventSequenceValidator({ maxOpenLifecycles: 1 });
  released.push(event(0, { kind: "turn.start" }));
  released.push(event(1, { kind: "stage.open", id: "s", label: "one" }));
  released.push(event(2, { kind: "stage.close", id: "s" }));
  released.push(event(3, { kind: "tool.start", id: "t", name: "read", argsSummary: "" }));
  released.push(event(4, { kind: "tool.end", id: "t", status: "completed" }));
  released.push(event(5, { kind: "turn.end", stopReason: "end_turn" }));
  assert.equal(released.finish().peakOpenLifecycles, 1);
});

test("closed lifecycle ids remain reserved for the whole validated turn", () => {
  const cases: readonly [EventPayload, EventPayload, EventPayload][] = [
    [
      { kind: "stage.open", id: "same", label: "one" },
      { kind: "stage.close", id: "same" },
      { kind: "stage.open", id: "same", label: "two" },
    ],
    [
      { kind: "tool.start", id: "same", name: "read", argsSummary: "" },
      { kind: "tool.end", id: "same", status: "completed" },
      { kind: "tool.start", id: "same", name: "write", argsSummary: "" },
    ],
  ];

  for (const [open, close, reused] of cases) {
    const validator = new TurnEventSequenceValidator();
    validator.push(event(0, { kind: "turn.start" }));
    validator.push(event(1, open));
    validator.push(event(2, close));
    assert.equal(validator.openLifecycleCount, 0);
    assert.equal(validator.seenLifecycleIdCount, 1);
    expectCode("pebble_sequence_lifecycle_duplicate", () => {
      validator.push(event(3, reused));
    });
  }
});

test("seen-id cap stays bounded after lifecycles close", () => {
  const validator = new TurnEventSequenceValidator({
    maxOpenLifecycles: 1,
    maxSeenLifecycleIds: 2,
  });
  validator.push(event(0, { kind: "turn.start" }));
  validator.push(event(1, { kind: "stage.open", id: "s", label: "one" }));
  validator.push(event(2, { kind: "stage.close", id: "s" }));
  validator.push(event(3, { kind: "tool.start", id: "t", name: "read", argsSummary: "" }));
  validator.push(event(4, { kind: "tool.end", id: "t", status: "completed" }));
  assert.equal(validator.openLifecycleCount, 0);
  assert.equal(validator.seenLifecycleIdCount, 2);
  expectCode("pebble_sequence_seen_limit", () => {
    validator.push(event(5, { kind: "stage.open", id: "s2", label: "two" }));
  });
});

test("retained identity bytes are bounded and diagnostics truncate ids", () => {
  expectCode("pebble_sequence_invalid_options", () => {
    new TurnEventSequenceValidator({
      sessionId: "session-too-long",
      maxRetainedIdentityBytes: 4,
    });
  });

  const bounded = new TurnEventSequenceValidator({
    sessionId: "s",
    maxRetainedIdentityBytes: 5,
  });
  bounded.push(event(0, { kind: "turn.start" }, "s"));
  bounded.push(event(1, { kind: "stage.open", id: "1234", label: "one" }, "s"));
  const error = expectCode("pebble_sequence_identity_bytes_limit", () => {
    bounded.push(event(2, {
      kind: "tool.start",
      id: "x".repeat(10_000),
      name: "read",
      argsSummary: "",
    }, "s"));
  });
  assert.ok(error.message.length < 512);
});

test("terminal error pairing is exact", () => {
  const missingError = new TurnEventSequenceValidator();
  missingError.push(event(0, { kind: "turn.start" }));
  expectCode("pebble_sequence_terminal_mismatch", () => {
    missingError.push(event(1, { kind: "turn.end", stopReason: "error" }));
  });

  const wrongEnd = new TurnEventSequenceValidator();
  wrongEnd.push(event(0, { kind: "turn.start" }));
  wrongEnd.push(event(1, { kind: "error", message: "settled", retryable: false }));
  expectCode("pebble_sequence_terminal_mismatch", () => {
    wrongEnd.push(event(2, { kind: "turn.end", stopReason: "end_turn" }));
  });

  const intervening = new TurnEventSequenceValidator();
  intervening.push(event(0, { kind: "turn.start" }));
  intervening.push(event(1, { kind: "error", message: "settled", retryable: false }));
  expectCode("pebble_sequence_error_order", () => {
    intervening.push(event(2, { kind: "usage", usage: {
      in: 1,
      out: 0,
      cacheRead: 0,
      cacheWrite: 0,
      costUsd: null,
      model: "m",
    } }));
  });

  const duplicate = new TurnEventSequenceValidator();
  duplicate.push(event(0, { kind: "turn.start" }));
  duplicate.push(event(1, { kind: "error", message: "one", retryable: false }));
  expectCode("pebble_sequence_terminal_duplicate", () => {
    duplicate.push(event(2, { kind: "error", message: "two", retryable: false }));
  });
});

test("turn.end rejects dangling stage and tool lifecycles", () => {
  const cases: readonly EventPayload[] = [
    { kind: "stage.open", id: "s", label: "open" },
    { kind: "tool.start", id: "t", name: "read", argsSummary: "" },
  ];
  for (const opened of cases) {
    const validator = new TurnEventSequenceValidator();
    validator.push(event(0, { kind: "turn.start" }));
    validator.push(event(1, opened));
    expectCode("pebble_sequence_dangling_lifecycles", () => {
      validator.push(event(2, { kind: "turn.end", stopReason: "end_turn" }));
    });
  }
});

test("finish rejects incomplete and dangling streams", () => {
  expectCode("pebble_sequence_turn_start_required", () => {
    new TurnEventSequenceValidator().finish();
  });

  const noTerminal = new TurnEventSequenceValidator();
  noTerminal.push(event(0, { kind: "turn.start" }));
  expectCode("pebble_sequence_terminal_missing", () => noTerminal.finish());

  const dangling = new TurnEventSequenceValidator();
  dangling.push(event(0, { kind: "turn.start" }));
  dangling.push(event(1, { kind: "tool.start", id: "t", name: "read", argsSummary: "" }));
  expectCode("pebble_sequence_dangling_lifecycles", () => dangling.end());

  const errorPrelude = new TurnEventSequenceValidator();
  errorPrelude.push(event(0, { kind: "turn.start" }));
  errorPrelude.push(event(1, { kind: "error", message: "settled", retryable: false }));
  expectCode("pebble_sequence_terminal_mismatch", () => errorPrelude.finish());
});

test("nothing follows turn.end and duplicate terminals are distinguished", () => {
  const eventAfter = new TurnEventSequenceValidator();
  eventAfter.push(event(0, { kind: "turn.start" }));
  eventAfter.push(event(1, { kind: "turn.end", stopReason: "end_turn" }));
  expectCode("pebble_sequence_event_after_terminal", () => {
    eventAfter.push(event(2, { kind: "delta.text", text: "late" }));
  });

  const duplicateEnd = new TurnEventSequenceValidator();
  duplicateEnd.push(event(0, { kind: "turn.start" }));
  duplicateEnd.push(event(1, { kind: "turn.end", stopReason: "end_turn" }));
  expectCode("pebble_sequence_terminal_duplicate", () => {
    duplicateEnd.push(event(2, { kind: "turn.end", stopReason: "end_turn" }));
  });

  const finished = new TurnEventSequenceValidator();
  finished.push(event(0, { kind: "turn.start" }));
  finished.push(event(1, { kind: "turn.end", stopReason: "end_turn" }));
  finished.finish();
  expectCode("pebble_sequence_stream_finished", () => {
    finished.push(event(2, { kind: "delta.text", text: "late" }));
  });
});

test("terminal summary snapshots caller-owned event state", () => {
  const validator = new TurnEventSequenceValidator();
  validator.push(event(0, { kind: "turn.start" }));
  const terminal = event(1, { kind: "turn.end", stopReason: "end_turn" });
  validator.push(terminal);
  (terminal as { stopReason: string }).stopReason = "forged";
  assert.equal(validator.finish().stopReason, "end_turn");
});

test("event snapshot prevents proxy TOCTOU from forging terminal evidence", () => {
  const validator = new TurnEventSequenceValidator();
  validator.push(event(0, { kind: "turn.start" }));
  const target = event(1, { kind: "turn.end", stopReason: "end_turn" });
  let reads = 0;
  const terminal = new Proxy(target, {
    getOwnPropertyDescriptor(source, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(source, key);
      if (key !== "stopReason" || descriptor === undefined) return descriptor;
      reads++;
      return { ...descriptor, value: reads === 1 ? "end_turn" : "forged" };
    },
  });
  validator.push(terminal);
  assert.equal(validator.finish().stopReason, "end_turn");
  assert.equal(reads, 1);
});

test("sequence options reject accessors without invoking them", () => {
  let reads = 0;
  const options = {};
  Object.defineProperty(options, "firstSeq", {
    enumerable: true,
    get() {
      reads++;
      return 0;
    },
  });
  expectCode("pebble_sequence_invalid_options", () => {
    new TurnEventSequenceValidator(options);
  });
  assert.equal(reads, 0);
});

test("invalid options fail with coded errors", () => {
  for (const options of [
    { firstSeq: -1 },
    { firstSeq: 1.5 },
    { firstSeq: Number.MAX_SAFE_INTEGER },
    { maxOpenLifecycles: -1 },
    { maxOpenLifecycles: Number.MAX_SAFE_INTEGER + 1 },
    { maxSeenLifecycleIds: -1 },
    { maxSeenLifecycleIds: Number.MAX_SAFE_INTEGER + 1 },
    { maxRetainedIdentityBytes: -1 },
    { maxRetainedIdentityBytes: Number.MAX_SAFE_INTEGER + 1 },
    { sessionId: "" },
  ]) {
    expectCode("pebble_sequence_invalid_options", () => {
      new TurnEventSequenceValidator(options);
    });
  }
});

test("sequence arithmetic fails closed outside safe-integer range", () => {
  const unsafe = new TurnEventSequenceValidator();
  expectCode("pebble_sequence_number_mismatch", () => {
    unsafe.push(event(Number.MAX_SAFE_INTEGER + 1, { kind: "turn.start" }));
  });

  const edge = new TurnEventSequenceValidator({
    firstSeq: Number.MAX_SAFE_INTEGER - 1,
  });
  edge.push(event(Number.MAX_SAFE_INTEGER - 1, { kind: "turn.start" }));
  edge.push(event(Number.MAX_SAFE_INTEGER, {
    kind: "turn.end",
    stopReason: "end_turn",
  }));
  assert.equal(edge.finish().lastSeq, Number.MAX_SAFE_INTEGER);
});
