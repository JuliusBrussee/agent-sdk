import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defineRunReceipt,
  validateRunReceipt,
} from "../dist/index.js";
import { ReceiptRecorder } from "../dist/budget.js";

function call(overrides = {}) {
  return {
    provider: "anthropic",
    model: "claude-haiku-4-5",
    inputTokens: 1,
    outputTokens: 2,
    cacheReadTokens: 3,
    cacheWriteTokens: 0,
    reasoningTokens: 1,
    estimatedUsd: 1,
    unpriced: false,
    usageBasis: "provider_reported",
    ...overrides,
  };
}

function receipt(overrides = {}) {
  return {
    schema: "caveman.agent.run-receipt.v1",
    runId: "run-1",
    agentId: "agent-1",
    basis: "estimated_list_price_subtotal",
    claimBasis: "inferred",
    stopReason: "complete",
    denomination: "none",
    capBreached: false,
    overspent: 0,
    totalEstimatedUsd: 0,
    totalTokens: 0,
    unpriced: false,
    calls: [],
    tools: [],
    subagents: [],
    tranches: [],
    breakers: [],
    compactions: [],
    ...overrides,
  };
}

function assertDeepFrozen(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child, seen);
}

function validNestedReceipt() {
  return receipt({
    runId: "child-1",
    agentId: "child-agent",
    denomination: "usd",
    max: 1,
    released: 1,
    spent: 0.5,
    calls: [call({
      provider: "openai",
      model: "gpt-5-mini",
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 2,
      reasoningTokens: 0,
      estimatedUsd: 0.5,
    })],
    totalTokens: 4,
    totalEstimatedUsd: 0.5,
  });
}

function validComplexReceipt() {
  return receipt({
    denomination: "usd",
    max: 10,
    released: 5,
    spent: 1.5,
    calls: [call()],
    tools: [{ name: "read_file", calls: 2, errors: 1 }],
    subagents: [validNestedReceipt()],
    tranches: [{ amount: 1, reason: "eval passed", atCall: 1 }],
    breakers: [{
      kind: "retry_attempted",
      count: 1,
      reservedSpend: 0.2,
      measuredSpend: 0.1,
      spendBasis: "provider_reported",
    }],
    compactions: [{
      index: 0,
      tier: "summarized",
      preTokens: 10,
      postTokens: 6,
      pinnedSegmentIds: ["system"],
      elidedSegmentDigests: ["a".repeat(64)],
      summarySchemaVersion: 1,
      cacheState: "cold",
      meteredCost: 0,
      meteredBasis: "measured",
      modeledNetTokens: -2,
      modeledBasis: "modeled",
      workingCallsAfter: 1,
    }],
    totalTokens: 10,
    totalEstimatedUsd: 1.5,
  });
}

test("receipt parser is one public validator returning detached deeply frozen data", () => {
  assert.equal(defineRunReceipt, validateRunReceipt);
  const source = validComplexReceipt();
  const defined = defineRunReceipt(source);

  assert.notEqual(defined, source);
  assert.notEqual(defined.calls, source.calls);
  assert.notEqual(defined.calls[0], source.calls[0]);
  assert.notEqual(defined.subagents[0], source.subagents[0]);
  assert.equal(defined.compactions[0].modeledNetTokens, -2);
  assertDeepFrozen(defined);

  source.calls[0].provider = "mutated";
  source.subagents[0].agentId = "mutated";
  assert.equal(defined.calls[0].provider, "anthropic");
  assert.equal(defined.subagents[0].agentId, "child-agent");
  assert.throws(() => defined.calls.push(call()), TypeError);
  assert.throws(() => { defined.calls[0].provider = "mutated"; }, TypeError);
});

test("JSON wire omissions remain canonical and explicit optional values survive", () => {
  const defined = validateRunReceipt(receipt());
  assert.equal(Object.hasOwn(defined, "max"), false);
  assert.equal(Object.hasOwn(defined, "released"), false);
  assert.equal(Object.hasOwn(defined, "spent"), false);
  assert.equal(defined.max, undefined);

  const resumed = validateRunReceipt(receipt({
    denomination: "usd",
    max: 1,
    released: 1,
    spent: 0.25,
    totalEstimatedUsd: 0.25,
    totalTokens: 10,
    resume: {
      attempts: 2,
      priorCalls: 1,
      priorEstimatedUsd: 0.25,
      priorTokens: 10,
      priorUnpriced: false,
      priorSettled: 0.25,
      possibleDoubleCountCalls: 1,
      discardedPartialTurn: true,
    },
  }));
  assert.equal(resumed.resume?.priorSettled, 0.25);
});

test("ReceiptRecorder output is exact across JSON replay at every optional depth", () => {
  const recorder = new ReceiptRecorder();
  recorder.recordCall(call());
  recorder.recordCompaction({
    tier: "evicted",
    preTokens: 10,
    postTokens: 5,
    pinnedSegmentIds: [],
    elidedSegmentDigests: [],
    summarySchemaVersion: undefined,
    cacheState: "unknown",
    meteredCost: 0,
  });
  const produced = recorder.build({
    runId: "producer-1",
    agentId: "producer-agent",
    stopReason: "complete",
    meter: undefined,
    breakers: [{
      kind: "no_progress",
      tool: undefined,
      count: 2,
      signature: "b".repeat(64),
    }],
    resume: {
      attempts: 2,
      priorCalls: 0,
      priorEstimatedUsd: 0,
      priorTokens: 0,
      priorUnpriced: false,
      priorSettled: undefined,
      possibleDoubleCountCalls: 0,
      discardedPartialTurn: false,
    },
  });
  const replayed = JSON.parse(JSON.stringify(produced));

  assert.deepEqual(produced, replayed);
  assert.deepEqual(validateRunReceipt(produced), replayed);
  assert.equal(Object.hasOwn(produced, "max"), false);
  assert.equal(Object.hasOwn(produced.calls[0], "clampedOutputTokens"), false);
  assert.equal(Object.hasOwn(produced.breakers[0], "tool"), false);
  assert.equal(Object.hasOwn(produced.compactions[0], "summarySchemaVersion"), false);
  assert.equal(Object.hasOwn(produced.resume, "priorSettled"), false);
});

test("measured retry and compaction evidence is budget-backed and call-bounded", () => {
  const providerRetry = {
    kind: "retry_attempted",
    count: 1,
    reservedSpend: 2,
    measuredSpend: 1,
    spendBasis: "provider_reported",
  };
  const preStreamRetry = {
    kind: "retry_attempted",
    count: 1,
    reservedSpend: 2,
    measuredSpend: 0,
    spendBasis: "pre_stream_no_usage",
  };
  const paidCompaction = {
    index: 0,
    tier: "summarized",
    preTokens: 10,
    postTokens: 5,
    pinnedSegmentIds: [],
    elidedSegmentDigests: [],
    summarySchemaVersion: 1,
    cacheState: "cold",
    meteredCost: 1,
    meteredBasis: "measured",
    modeledNetTokens: 0,
    modeledBasis: "modeled",
    workingCallsAfter: 1,
  };

  assert.throws(
    () => validateRunReceipt(receipt({ breakers: [preStreamRetry] })),
    /cave_run_receipt_invalid:measured_spend_budget/,
  );
  assert.throws(
    () => validateRunReceipt(receipt({
      calls: [call()],
      totalTokens: 6,
      totalEstimatedUsd: 1,
      compactions: [paidCompaction],
    })),
    /cave_run_receipt_invalid:measured_spend_budget/,
  );
  assert.throws(
    () => validateRunReceipt(receipt({
      denomination: "tokens",
      max: 10,
      released: 10,
      spent: 6,
      calls: [call({ estimatedUsd: 0 })],
      totalTokens: 6,
      breakers: [{ ...providerRetry, reservedSpend: 1.5 }],
    })),
    /cave_run_receipt_invalid:measured_spend/,
  );
  assert.throws(
    () => validateRunReceipt(receipt({
      denomination: "usd",
      max: 10,
      released: 10,
      spent: 1,
      calls: [call({ estimatedUsd: 0.5 }), call({ estimatedUsd: 0.5 })],
      totalTokens: 12,
      totalEstimatedUsd: 1,
      breakers: [{ ...providerRetry, measuredSpend: 0.6 }],
      compactions: [{ ...paidCompaction, meteredCost: 0.6 }],
    })),
    /cave_run_receipt_invalid:measured_spend/,
  );
  assert.throws(
    () => validateRunReceipt(receipt({
      denomination: "usd",
      max: 10,
      released: 1,
      spent: 0,
      breakers: [preStreamRetry],
    })),
    /cave_run_receipt_invalid:measured_spend_budget/,
  );
  assert.throws(
    () => validateRunReceipt(receipt({
      denomination: "usd",
      max: 10,
      released: 10,
      spent: 1,
      calls: [call()],
      totalTokens: 6,
      totalEstimatedUsd: 1,
      breakers: [{ ...providerRetry, measuredSpend: 2 }],
    })),
    /cave_run_receipt_invalid:measured_spend/,
  );
  assert.throws(
    () => validateRunReceipt(receipt({
      denomination: "usd",
      max: 10,
      released: 10,
      spent: 1,
      calls: [call()],
      totalTokens: 6,
      totalEstimatedUsd: 1,
      breakers: [providerRetry, { ...providerRetry, count: 2, measuredSpend: 0 }],
    })),
    /cave_run_receipt_invalid:measured_spend_calls/,
  );
  assert.throws(
    () => validateRunReceipt(receipt({
      denomination: "usd",
      max: 10,
      released: 10,
      spent: 1,
      calls: [call()],
      totalTokens: 6,
      totalEstimatedUsd: 1,
      compactions: [{ ...paidCompaction, meteredCost: 2 }],
    })),
    /cave_run_receipt_invalid:measured_spend/,
  );

  const beforeProvider = validateRunReceipt(receipt({
    denomination: "tokens",
    max: 10,
    released: 10,
    spent: 0,
    breakers: [preStreamRetry],
  }));
  assert.equal(beforeProvider.calls.length, 0);
  const unavailable = validateRunReceipt(receipt({
    denomination: "tokens",
    max: 100,
    released: 100,
    spent: 25,
    calls: [call({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      estimatedUsd: 0,
      unpriced: true,
      usageBasis: "unavailable",
    })],
    totalTokens: 0,
    unpriced: true,
    breakers: [{
      ...providerRetry,
      reservedSpend: 25,
      measuredSpend: 25,
      spendBasis: "unavailable_worst_case",
    }],
  }));
  assert.equal(unavailable.spent, 25);
});

test("resume zero-call attempts cannot carry settled totals", () => {
  const emptyResume = {
    attempts: 2,
    priorCalls: 0,
    priorEstimatedUsd: 0,
    priorTokens: 0,
    priorUnpriced: false,
    possibleDoubleCountCalls: 1,
    discardedPartialTurn: true,
  };
  const resumed = validateRunReceipt(receipt({ resume: emptyResume }));
  assert.equal(resumed.resume?.possibleDoubleCountCalls, 1);

  for (const resume of [
    { ...emptyResume, priorEstimatedUsd: 1 },
    { ...emptyResume, priorTokens: 1 },
    { ...emptyResume, priorUnpriced: true },
  ]) {
    assert.throws(
      () => validateRunReceipt(receipt({
        resume,
        totalEstimatedUsd: resume.priorEstimatedUsd,
        totalTokens: resume.priorTokens,
        unpriced: resume.priorUnpriced,
      })),
      /cave_run_receipt_invalid:resume_zero_calls/,
    );
  }
  assert.throws(
    () => validateRunReceipt(receipt({
      denomination: "tokens",
      max: 10,
      released: 10,
      spent: 1,
      resume: { ...emptyResume, priorSettled: 1 },
    })),
    /cave_run_receipt_invalid:resume_zero_calls/,
  );
});

test("tranches prove positive initial release and monotonic call order", () => {
  assert.throws(
    () => validateRunReceipt(receipt({
      denomination: "tokens",
      max: 10,
      released: 4,
      spent: 0,
      tranches: [{ amount: 4, reason: "all later", atCall: 0 }],
    })),
    /cave_run_receipt_invalid:tranches/,
  );
  assert.throws(
    () => validateRunReceipt(receipt({
      denomination: "tokens",
      max: 10,
      released: 7,
      spent: 0,
      tranches: [
        { amount: 2, reason: "later", atCall: 2 },
        { amount: 2, reason: "time travel", atCall: 1 },
      ],
    })),
    /cave_run_receipt_invalid:tranches/,
  );
  const valid = validateRunReceipt(receipt({
    denomination: "tokens",
    max: 10,
    released: 7,
    spent: 0,
    tranches: [
      { amount: 2, reason: "same checkpoint", atCall: 1 },
      { amount: 2, reason: "same checkpoint again", atCall: 1 },
    ],
  }));
  assert.equal(valid.released - valid.tranches.reduce((sum, item) => sum + item.amount, 0), 3);
  assert.equal(validateRunReceipt(receipt({
    denomination: "usd",
    max: 1e-20,
    released: 1e-20,
    spent: 0,
  })).released, 1e-20);
});

test("run ids are unique across tree and each child wallet fits parent release", () => {
  assert.throws(
    () => validateRunReceipt(receipt({
      subagents: [receipt({ runId: "run-1" })],
    })),
    /cave_run_receipt_invalid:run_id_tree/,
  );
  assert.throws(
    () => validateRunReceipt(receipt({
      subagents: ["one", "two"].map(() => receipt({ runId: "same-sibling" })),
    })),
    /cave_run_receipt_invalid:run_id_tree/,
  );
  assert.throws(
    () => validateRunReceipt(receipt({
      denomination: "tokens",
      max: 10,
      released: 4,
      spent: 0,
      subagents: [receipt({
        runId: "oversized-child",
        denomination: "tokens",
        max: 5,
        released: 5,
        spent: 0,
      })],
    })),
    /cave_run_receipt_invalid:subagent_wallet/,
  );
  const sequential = validateRunReceipt(receipt({
    denomination: "tokens",
    max: 10,
    released: 4,
    spent: 0,
    subagents: ["one", "two"].map((suffix) => receipt({
      runId: `sequential-${suffix}`,
      denomination: "tokens",
      max: 4,
      released: 4,
      spent: 0,
    })),
  }));
  assert.equal(sequential.subagents.length, 2);
});

test("ReceiptRecorder snapshots untrusted subagent receipts through canonical parser", () => {
  const child = receipt({ runId: "mutable-child", agentId: "before" });
  const recorder = new ReceiptRecorder();
  recorder.recordSubagent(child);
  child.agentId = "after";
  child.calls.push(call());

  const produced = recorder.build({
    runId: "parent-recorder",
    agentId: "parent",
    stopReason: "complete",
    meter: undefined,
  });
  assert.equal(produced.subagents[0].agentId, "before");
  assert.equal(produced.subagents[0].calls.length, 0);
  assertDeepFrozen(produced.subagents[0]);
  assert.throws(
    () => new ReceiptRecorder().recordSubagent(new Proxy(receipt({ runId: "proxy" }), {})),
    /cave_run_receipt_invalid:object/,
  );
});

test("ReceiptRecorder build rejects duplicate run ids across independently valid children", () => {
  const recorder = new ReceiptRecorder();
  recorder.recordSubagent(receipt({ runId: "duplicate-child" }));
  recorder.recordSubagent(receipt({ runId: "duplicate-child" }));
  assert.throws(
    () => recorder.build({
      runId: "duplicate-parent",
      agentId: "parent",
      stopReason: "complete",
      meter: undefined,
    }),
    /cave_run_receipt_invalid:run_id_tree/,
  );
});

test("ReceiptRecorder snapshots compaction arrays when evidence is recorded", () => {
  const pinnedSegmentIds = ["system"];
  const elidedSegmentDigests = ["a".repeat(64)];
  const recorder = new ReceiptRecorder();
  recorder.recordCompaction({
    tier: "evicted",
    preTokens: 10,
    postTokens: 5,
    pinnedSegmentIds,
    elidedSegmentDigests,
    summarySchemaVersion: undefined,
    cacheState: "unknown",
    meteredCost: 0,
  });
  pinnedSegmentIds[0] = "mutated";
  elidedSegmentDigests[0] = "b".repeat(64);
  pinnedSegmentIds.push("late");
  elidedSegmentDigests.push("c".repeat(64));

  const produced = recorder.build({
    runId: "detached-compaction",
    agentId: "agent",
    stopReason: "complete",
    meter: undefined,
  });
  assert.deepEqual(produced.compactions[0].pinnedSegmentIds, ["system"]);
  assert.deepEqual(produced.compactions[0].elidedSegmentDigests, ["a".repeat(64)]);
});

test("resume settlement reconciles provider evidence and unavailable spend stays released-bound", () => {
  const baseResume = {
    attempts: 2,
    priorCalls: 1,
    priorEstimatedUsd: 5,
    priorTokens: 7,
    priorUnpriced: false,
    priorSettled: 5,
    possibleDoubleCountCalls: 0,
    discardedPartialTurn: false,
  };
  assert.throws(
    () => validateRunReceipt(receipt({
      denomination: "usd",
      max: 10,
      released: 10,
      spent: 1,
      totalEstimatedUsd: 5,
      totalTokens: 7,
      resume: { ...baseResume, priorSettled: 1 },
    })),
    /cave_run_receipt_invalid:resume_prior_settled/,
  );
  assert.throws(
    () => validateRunReceipt(receipt({
      denomination: "tokens",
      max: 20,
      released: 20,
      spent: 6,
      totalEstimatedUsd: 5,
      totalTokens: 7,
      resume: { ...baseResume, priorSettled: 6 },
    })),
    /cave_run_receipt_invalid:resume_prior_settled/,
  );
  const conservative = validateRunReceipt(receipt({
    denomination: "usd",
    max: 10,
    released: 10,
    spent: 6,
    totalEstimatedUsd: 5,
    totalTokens: 7,
    unpriced: true,
    resume: { ...baseResume, priorUnpriced: true, priorSettled: 6 },
  }));
  assert.equal(conservative.resume?.priorSettled, 6);

  assert.throws(
    () => validateRunReceipt(receipt({
      denomination: "tokens",
      max: 10,
      released: 10,
      spent: 11,
      capBreached: true,
      overspent: 1,
      calls: [call({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        estimatedUsd: 0,
        unpriced: true,
        usageBasis: "unavailable",
      })],
      unpriced: true,
    })),
    /cave_run_receipt_invalid:spent/,
  );
});

test("unknown keys and malformed data fail closed at every nested level", () => {
  assert.throws(
    () => defineRunReceipt({ ...receipt(), verifiedSavingsUsd: 1 }),
    /cave_run_receipt_invalid:receipt/,
  );
  assert.throws(
    () => defineRunReceipt({ ...receipt(), claimBasis: "verified" }),
    /cave_run_receipt_invalid:identity/,
  );
  assert.throws(
    () => defineRunReceipt({ ...receipt(), calls: [{ ...call(), surprise: true }] }),
    /cave_run_receipt_invalid:call/,
  );
  assert.throws(
    () => defineRunReceipt({
      ...receipt(),
      subagents: [{ ...receipt({ runId: "child" }), permission: "allow" }],
    }),
    /cave_run_receipt_invalid:receipt/,
  );

  const accessor = call();
  Object.defineProperty(accessor, "model", { enumerable: true, get: () => "hidden" });
  assert.throws(
    () => defineRunReceipt({ ...receipt(), calls: [accessor] }),
    /cave_run_receipt_invalid:object/,
  );
  assert.throws(
    () => defineRunReceipt(Object.assign(Object.create({ inherited: true }), receipt())),
    /cave_run_receipt_invalid:object/,
  );
  const sparse = receipt();
  sparse.tools = new Array(1);
  assert.throws(() => defineRunReceipt(sparse), /cave_run_receipt_invalid:array/);
  const cyclic = receipt();
  cyclic.subagents = [cyclic];
  assert.throws(() => defineRunReceipt(cyclic), /cave_run_receipt_invalid:cycle/);
  const { proxy, revoke } = Proxy.revocable(receipt(), {});
  revoke();
  assert.throws(() => defineRunReceipt(proxy), /cave_run_receipt_invalid:object/);
  assert.throws(
    () => defineRunReceipt(new Proxy(receipt(), {})),
    /cave_run_receipt_invalid:object/,
  );
  assert.throws(
    () => defineRunReceipt({ ...receipt(), ["x".repeat(1024 * 1024 + 1)]: true }),
    /cave_run_receipt_invalid:string_bytes/,
  );
});

test("numeric accounting, usage, budget, and recursive totals reconcile", () => {
  for (const invalid of [
    { ...receipt(), totalEstimatedUsd: Number.NaN },
    { ...receipt(), totalTokens: -1 },
    { ...receipt(), totalTokens: Number.MAX_SAFE_INTEGER + 1 },
    { ...receipt(), overspent: -0 },
    { ...receipt(), calls: [call({ reasoningTokens: 3 })], totalTokens: 6, totalEstimatedUsd: 1 },
    { ...receipt(), calls: [call({ unpriced: true })], totalTokens: 6, totalEstimatedUsd: 1, unpriced: true },
    { ...receipt(), calls: [call({ usageBasis: "unavailable" })], totalTokens: 6, totalEstimatedUsd: 1 },
    { ...receipt(), calls: [call()], totalTokens: 5, totalEstimatedUsd: 1 },
    { ...receipt(), tools: [{ name: "write", calls: 1, errors: 2 }] },
    { ...receipt(), breakers: [{ kind: "retry_exhausted", count: 1, measuredSpend: 0 }] },
    { ...receipt(), breakers: [{
      kind: "retry_attempted",
      count: 1,
      reservedSpend: 1,
      measuredSpend: 1,
      spendBasis: "pre_stream_no_usage",
    }] },
    { ...receipt(), denomination: "usd", max: 1, released: 2, spent: 0 },
    { ...receipt(), denomination: "usd", max: 1, released: 1, spent: 0,
      calls: [call()], totalTokens: 6, totalEstimatedUsd: 1 },
    { ...receipt(), denomination: "usd", max: 20, released: 1, spent: 0,
      tranches: [{ amount: 10, reason: "impossible", atCall: 0 }] },
    { ...receipt(), denomination: "none", max: 1 },
    { ...receipt(), capBreached: true },
    { ...receipt(), compactions: [{
      index: 0,
      tier: "evicted",
      preTokens: 100,
      postTokens: 1,
      pinnedSegmentIds: [],
      elidedSegmentDigests: [],
      cacheState: "unknown",
      meteredCost: 0,
      meteredBasis: "measured",
      modeledNetTokens: 9_899,
      modeledBasis: "modeled",
      workingCallsAfter: 100,
    }] },
  ]) {
    assert.throws(() => defineRunReceipt(invalid), /cave_run_receipt_invalid/);
  }

  const breached = validateRunReceipt(receipt({
    denomination: "tokens",
    max: 1,
    released: 1,
    spent: 2,
    capBreached: true,
    overspent: 1,
    calls: [call({
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      reasoningTokens: 0,
      estimatedUsd: 0,
    })],
    totalTokens: 2,
  }));
  assert.equal(breached.capBreached, true);
  assert.equal(breached.overspent, 1);
});

test("receipt recursion, arrays, nodes, strings, and serialized bytes are bounded", () => {
  let deep = receipt({ runId: "depth-leaf" });
  for (let depth = 0; depth < 9; depth++) {
    deep = receipt({ runId: `depth-${depth}`, subagents: [deep] });
  }
  assert.throws(() => defineRunReceipt(deep), /cave_run_receipt_invalid:subagent_depth/);

  assert.throws(
    () => defineRunReceipt({
      ...receipt(),
      tools: new Array(65_537).fill({ name: "read", calls: 1, errors: 0 }),
    }),
    /cave_run_receipt_invalid:array/,
  );
  assert.throws(
    () => defineRunReceipt(receipt({ agentId: "x".repeat(1024 * 1024 + 1) })),
    /cave_run_receipt_invalid:string_bytes/,
  );
  assert.throws(
    () => defineRunReceipt({ ...receipt(), calls: new Array(20_000).fill(call()) }),
    /cave_run_receipt_invalid:bounds/,
  );

  const largeName = "x".repeat(1024 * 1024 - 16);
  assert.throws(
    () => defineRunReceipt({
      ...receipt(),
      tools: Array.from({ length: 17 }, (_, index) => ({
        name: `${largeName}-${index}`,
        calls: 0,
        errors: 0,
      })),
    }),
    /cave_run_receipt_invalid:bytes/,
  );

  const escapedName = "\0".repeat(1024 * 1024 - 16);
  assert.throws(
    () => defineRunReceipt({
      ...receipt(),
      tools: Array.from({ length: 3 }, (_, index) => ({
        name: `${escapedName}-${index}`,
        calls: 0,
        errors: 0,
      })),
    }),
    /cave_run_receipt_invalid:bytes/,
  );
});
