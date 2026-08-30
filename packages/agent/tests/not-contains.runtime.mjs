import assert from "node:assert/strict";
import { test } from "node:test";
import { eval as defineEval } from "../dist/index.js";
test("agent compiler runner exposes no competing grader API", async () => {
  const compileRunner = await import("../dist/compile-runner.js");
  assert.equal(Object.hasOwn(compileRunner, "grade"), false);
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
