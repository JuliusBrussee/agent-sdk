import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { renderReceipt } from "../dist/index.js";

// The goldens are the spec (goldens/README.md): each committed receipt
// fixture pins timestamps, durations, and run paths, so the rendered print
// must equal the golden bytes exactly — no normalizer, no trimming. Every
// dollar in a fixture is reproducible from src/catalog.ts list prices.
const CASES = [
  "receipt-warm",
  "receipt-cold",
  "receipt-unpriced",
  "receipt-zero-turn",
  "receipt-resumed",
];

async function fixture(name) {
  return JSON.parse(await readFile(
    new URL(`./fixtures/receipts/${name}.json`, import.meta.url),
    "utf8",
  ));
}

async function golden(name) {
  return readFile(new URL(`../goldens/${name}.txt`, import.meta.url), "utf8");
}

for (const name of CASES) {
  test(`renderReceipt reproduces ${name} golden byte-exact`, async () => {
    assert.equal(renderReceipt(await fixture(name)), await golden(name));
  });
}

test("the word saved appears in no rendered receipt", async () => {
  for (const name of CASES) {
    assert.equal(renderReceipt(await fixture(name)).includes("saved"), false);
  }
});

test("unpriced receipts never print a dollar figure", async () => {
  const rendered = renderReceipt(await fixture("receipt-unpriced"));
  assert.equal(rendered.includes("$"), false);
  assert.match(rendered, /unpriced — acme-lab-preview is not in the public catalog/);
});

function call(overrides = {}) {
  return {
    provider: "anthropic",
    model: "claude-sonnet-5",
    inputTokens: 1000,
    outputTokens: 100,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    unpriced: false,
    ...overrides,
  };
}

function receipt(overrides = {}) {
  return {
    stopReason: "complete",
    denomination: "none",
    totalEstimatedUsd: 0.003,
    unpriced: false,
    calls: [call()],
    mode: "observe-only",
    durationMs: 1000,
    receiptPath: ".caveman/runs/2026-08-14T15-00-00/receipt.json",
    ...overrides,
  };
}

test("a stopped run says it stopped, named in plain words", () => {
  for (const [reason, text] of [
    ["budget_exhausted", "run stopped — budget exhausted"],
    ["loop_detected", "run stopped — loop detected"],
    ["no_progress", "run stopped — no progress"],
    ["deadline", "run stopped — deadline"],
  ]) {
    const rendered = renderReceipt(receipt({ stopReason: reason }));
    assert.equal(rendered.startsWith(`${text} · 1 turn ·`), true, reason);
    assert.equal(rendered.includes("run complete"), false);
  }
});

test("a breached cap prints the overage, never a negative percent", () => {
  const rendered = renderReceipt(receipt({
    stopReason: "budget_exhausted",
    denomination: "usd",
    max: 0.05,
    spent: 0.06,
    capBreached: true,
    totalEstimatedUsd: 0.06,
  }));
  assert.match(rendered, /\$0\.0600 spent of \$0\.05 cap · over by \$0\.0100 \(provider-reported after reservation\)/);
  assert.equal(rendered.includes("% remains"), false);
  assert.doesNotMatch(rendered, /-\d+%/);
  const tokens = renderReceipt(receipt({
    denomination: "tokens",
    max: 1000,
    spent: 1200,
    capBreached: true,
  }));
  assert.match(tokens, /token cap: 1,200 spent of 1,000 cap · over by 200 \(provider-reported after reservation\)/);
});

test("cold estimate covers subagent calls — same scope as the cost line", () => {
  // Root: warm read. Subagent: plain calls. Cost includes the subagent, so
  // the cold estimate must too; the old root-only recompute would falsely
  // read the subagent's spend as a cache-write premium.
  const root = call({ inputTokens: 500, cacheReadTokens: 4000, outputTokens: 100 });
  const child = call({ model: "claude-haiku-4-5", inputTokens: 2000, outputTokens: 200 });
  // catalog: root cold = 4500*2 + 100*10 = 0.01, child = 2000*1 + 200*5 = 0.003
  const rendered = renderReceipt(receipt({
    calls: [root],
    subagents: [{ calls: [child] }],
    totalEstimatedUsd: 0.0059,
  }));
  assert.match(rendered, /cold estimate  \$0\.0130   inferred/);
  // Model + token rows aggregate over the same scope.
  assert.match(rendered, /claude-sonnet-5 \(1 call\) · claude-haiku-4-5 \(1 call\)/);
  assert.match(rendered, /input          6,500 tok/);
});

test("premium continuation needs provider-reported cache writes, not just cost > cold", () => {
  // Cost above the cold estimate with ZERO cache writes must not be
  // explained as a cache-write premium.
  const rendered = renderReceipt(receipt({
    calls: [call({ inputTokens: 1000, outputTokens: 100 })],
    totalEstimatedUsd: 0.9,
  }));
  assert.equal(rendered.includes("up-front"), false);
  const written = renderReceipt(receipt({
    calls: [call({ inputTokens: 1000, cacheWriteTokens: 4000, outputTokens: 100 })],
    totalEstimatedUsd: 0.9,
  }));
  assert.match(written, /premium to write your prefix into the provider cache/);
});

test("a run that both read and wrote cache shows both figures", () => {
  const rendered = renderReceipt(receipt({
    calls: [call({ cacheReadTokens: 3000, cacheWriteTokens: 2000 })],
  }));
  assert.match(rendered, /3,000 read warm · 2,000 written to cache \(provider-reported\)/);
});

test("zero root turns with subagent spend renders the body, not the absence", () => {
  const rendered = renderReceipt(receipt({
    calls: [],
    subagents: [{ calls: [call()] }],
  }));
  assert.equal(rendered.includes("no model calls were made"), false);
  assert.match(rendered, /^run complete · 1 turn ·/);
});

test("recurring-priced models get an explicit unavailable cold estimate", () => {
  const rendered = renderReceipt(receipt({
    calls: [call({ provider: "deepseek", model: "deepseek-v4-flash" })],
  }));
  assert.match(rendered, /cold estimate  unavailable — deepseek-v4-flash uses recurring pricing/);
});

test("a subagent call that cannot be repriced drops the cold estimate line", () => {
  const rendered = renderReceipt(receipt({
    calls: [call()],
    subagents: [{ calls: [call({ provider: "deepseek", model: "deepseek-v4-flash" })] }],
  }));
  assert.equal(rendered.includes("cold estimate"), false);
});

test("a resumed receipt drops the cold estimate and attributes prior spend", () => {
  const rendered = renderReceipt(receipt({
    resume: {
      attempts: 2,
      priorCalls: 3,
      priorEstimatedUsd: 0.001,
      priorUnpriced: false,
      possibleDoubleCountCalls: 0,
      discardedPartialTurn: false,
    },
  }));
  // The cost line covers prior attempts this attempt's calls cannot reprice:
  // no cross-scope cold estimate, ever.
  assert.equal(rendered.includes("cold estimate"), false);
  assert.match(rendered, /resumed\s+attempt 2 · prior attempts: 3 calls, \$0\.0010 — included in the totals above/);
});

test("a resumed receipt with unpriced prior attempts prints no prior dollar figure", () => {
  const rendered = renderReceipt(receipt({
    unpriced: true,
    calls: [call({ unpriced: true, model: "acme-lab-preview" })],
    resume: {
      attempts: 3,
      priorCalls: 2,
      priorEstimatedUsd: 0,
      priorUnpriced: true,
      possibleDoubleCountCalls: 1,
      discardedPartialTurn: true,
    },
  }));
  assert.match(rendered, /prior attempts: 2 calls \(unpriced\)/);
  assert.match(rendered, /1 call was in flight at a crash/);
  assert.equal(rendered.includes("$"), false);
});
