import assert from "node:assert/strict";
import { test } from "node:test";
import { eval as defineEval } from "../dist/index.js";
import { grade } from "../dist/compile-runner.js";

test("not_contains fails when any fragment is present, passes when absent", () => {
  const grader = { type: "not_contains", fragments: ["refund drafted"] };
  assert.equal(grade(grader, "escalated to a support lead, no draft", []), true);
  assert.equal(grade(grader, "a refund drafted on top of a chargeback", []), false);
  // Any present fragment fails the grader, not all.
  const multi = { type: "not_contains", fragments: ["alpha", "beta"] };
  assert.equal(grade(multi, "only beta appears", []), false);
  assert.equal(grade(multi, "neither appears", []), true);
});

test("unknown grader types still fail closed", () => {
  assert.equal(grade({ type: "totally_unknown" }, "anything", []), false);
});

test("eval fixtures accept not_contains and validate its fragments", () => {
  const fixture = defineEval({
    id: "no-refund-on-chargeback",
    input: "ticket",
    quality: [{ type: "not_contains", fragments: ["refund drafted"] }],
  });
  assert.equal(fixture.quality[0].type, "not_contains");
  assert.throws(
    () => defineEval({
      id: "empty",
      input: "ticket",
      quality: [{ type: "not_contains", fragments: [] }],
    }),
    /not_contains grader needs non-empty fragments/,
  );
  assert.throws(
    () => defineEval({
      id: "unknown",
      input: "ticket",
      quality: [{ type: "sentiment", fragments: ["x"] }],
    }),
    /unknown grader/,
  );
});
