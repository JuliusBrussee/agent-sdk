import assert from "node:assert/strict";
import test from "node:test";
import { Format } from "typebox/format";
import { Type } from "@earendil-works/pi-ai";

import { routine, schema, tool } from "../dist/index.js";
import { toolDefinitionSHA256 } from "../dist/build.js";
import {
  settleToolOutput,
  toolSchemaSemanticsVerified,
} from "../dist/tool-internal.js";

test("TypeBox output schema validates raw result exactly once", async () => {
  let calls = 0;
  const valid = tool({
    name: "typed_output_valid",
    description: "Return typed data.",
    input: schema.object({}),
    output: schema.object({ value: schema.string() }),
    effect: "read",
    execute() {
      calls += 1;
      return { value: "ok" };
    },
  });
  assert.deepEqual(await valid.execute({}), { value: "ok" });
  assert.equal(calls, 1);

  const invalid = tool({
    name: "typed_output_invalid",
    description: "Return malformed data.",
    input: schema.object({}),
    output: schema.object({ value: schema.string() }),
    effect: "read",
    execute() {
      calls += 1;
      return { value: 7 };
    },
  });
  await assert.rejects(
    invalid.execute({}),
    /cave_tool_output_schema_mismatch:typed_output_invalid/,
  );
  assert.equal(calls, 2);
});

test("TypeBox schemas are detached from caller mutation before execution", async () => {
  const input = schema.object({ value: schema.string() });
  const output = schema.string();
  const defined = tool({
    name: "detached_typebox_schema",
    description: "Keep declared contracts immutable.",
    input,
    output,
    effect: "read",
    execute() {
      input.properties.value.type = "number";
      output.type = "number";
      return 7;
    },
  });
  const identity = toolDefinitionSHA256(defined);
  await assert.rejects(
    defined.execute({ value: "ok" }),
    /cave_tool_output_schema_mismatch:detached_typebox_schema/,
  );
  assert.equal(defined.input.properties.value.type, "string");
  assert.equal(defined.output.type, "string");
  assert.equal(toolDefinitionSHA256(defined), identity);
});

test("executable TypeBox schemas retain semantics and bind function source into identity", async () => {
  const acceptedSchema = Type.Refine(Type.String(), (value) => value === "ok");
  const rejectedSchema = Type.Refine(Type.String(), (value) => value !== "ok");
  const make = (output) => tool({
    name: "typebox_refine_output",
    description: "Bind executable schema semantics.",
    input: schema.object({}),
    output,
    effect: "read",
    execute: () => "ok",
  });
  const accepted = make(acceptedSchema);
  const rejected = make(rejectedSchema);
  assert.equal(await accepted.execute({}), "ok");
  await assert.rejects(
    rejected.execute({}),
    /cave_tool_output_schema_mismatch:typebox_refine_output/,
  );
  assert.notEqual(toolDefinitionSHA256(accepted), toolDefinitionSHA256(rejected));

  acceptedSchema["~refine"][0].check = () => false;
  assert.equal(await accepted.execute({}), "ok");
  assert.equal(toolSchemaSemanticsVerified(accepted), false);
});

test("Standard output schema validates and returns transformed value", async () => {
  let inputConversions = 0;
  let outputConversions = 0;
  const standardOutput = {
    "~standard": {
      version: 1,
      vendor: "fixture",
      validate(value) {
        if (value === null || typeof value !== "object" ||
            typeof value.raw !== "string" || !/^\d+$/.test(value.raw)) {
          return { issues: [{ message: "raw integer required" }] };
        }
        return { value: { value: Number(value.raw) } };
      },
      jsonSchema: {
        input() {
          inputConversions += 1;
          return { type: "object" };
        },
        output() {
          outputConversions += 1;
          return {
            type: "object",
            properties: { value: { type: "integer" } },
            required: ["value"],
          };
        },
      },
    },
  };
  const defined = tool({
    name: "standard_output",
    description: "Normalize output.",
    input: schema.object({}),
    output: standardOutput,
    effect: "read",
    execute: () => ({ raw: "7" }),
  });
  assert.deepEqual(await defined.execute({}), { value: 7 });
  assert.equal(inputConversions, 0);
  assert.equal(outputConversions, 1);
  assert.deepEqual(defined.output.required, ["value"]);
});

test("Standard validators keep exact receivers and fail closed after method drift", async () => {
  const inputProps = {
    version: 1,
    vendor: "fixture-input",
    validate(value) {
      assert.equal(this, inputProps);
      return { value: { normalized: String(value.raw).toUpperCase() } };
    },
  };
  const outputProps = {
    version: 1,
    vendor: "fixture-output",
    validate(value) {
      assert.equal(this, outputProps);
      return { value: { result: value.result.toLowerCase() } };
    },
  };
  const originalInputValidate = inputProps.validate;
  const defined = tool({
    name: "captured_standard_methods",
    description: "Capture Standard Schema methods.",
    input: { "~standard": inputProps },
    inputJSONSchema: schema.object({ raw: schema.string() }),
    output: { "~standard": outputProps },
    outputJSONSchema: schema.object({ result: schema.string() }),
    effect: "read",
    execute: ({ normalized }) => ({ result: normalized }),
  });
  const identity = toolDefinitionSHA256(defined);
  assert.deepEqual(await defined.execute({ raw: "MiXeD" }), { result: "mixed" });
  inputProps.validate = () => ({ value: { normalized: "MUTATED" } });
  await assert.rejects(
    defined.execute({ raw: "MiXeD" }),
    /cave_tool_input_schema_mismatch:captured_standard_methods/,
  );
  inputProps.validate = originalInputValidate;
  outputProps.validate = () => ({ value: { result: "MUTATED" } });
  await assert.rejects(
    defined.execute({ raw: "MiXeD" }),
    /cave_tool_output_schema_mismatch:captured_standard_methods/,
  );
  assert.equal(toolDefinitionSHA256(defined), identity);
});

test("captured Standard receiver state cannot drift under a stable tool hash", async () => {
  const props = {
    version: 1,
    vendor: "fixture-state",
    mode: "upper",
    validate(value) {
      return { value: this.mode === "upper" ? String(value).toUpperCase() : String(value).toLowerCase() };
    },
  };
  const defined = tool({
    name: "standard_receiver_state",
    description: "Detect receiver drift.",
    input: schema.object({}),
    output: { "~standard": props },
    outputJSONSchema: schema.string(),
    effect: "read",
    execute: () => "MiXeD",
  });
  const identity = toolDefinitionSHA256(defined);
  assert.equal(await defined.execute({}), "MIXED");
  props.mode = "lower";
  await assert.rejects(
    defined.execute({}),
    /cave_tool_output_schema_mismatch:standard_receiver_state/,
  );
  assert.equal(toolDefinitionSHA256(defined), identity);
});

test("captured Standard receiver state includes jsonSchema dependencies", async () => {
  const props = {
    version: 1,
    vendor: "fixture-json-schema-state",
    jsonSchema: {
      mode: "upper",
      output() {
        return { type: "string" };
      },
    },
    validate(value) {
      return {
        value: this.jsonSchema.mode === "upper"
          ? String(value).toUpperCase()
          : String(value).toLowerCase(),
      };
    },
  };
  const defined = tool({
    name: "standard_json_schema_receiver_state",
    description: "Detect nested receiver drift.",
    input: schema.object({}),
    output: { "~standard": props },
    schemaSemanticsSHA256: "b".repeat(64),
    effect: "read",
    execute: () => "MiXeD",
  });
  const identity = toolDefinitionSHA256(defined);
  assert.equal(await defined.execute({}), "MIXED");
  props.jsonSchema.mode = "lower";
  await assert.rejects(
    defined.execute({}),
    /cave_tool_output_schema_mismatch:standard_json_schema_receiver_state/,
  );
  assert.equal(toolDefinitionSHA256(defined), identity);
});

test("captured Standard receiver cannot delegate through a mutated validate property", async () => {
  const props = {
    version: 1,
    vendor: "fixture-self-delegation",
    validate(value) {
      if (value === "outer") return this.validate("inner");
      return { value: String(value).toUpperCase() };
    },
  };
  const defined = tool({
    name: "standard_self_delegate",
    description: "Keep self calls on captured semantics.",
    input: schema.object({}),
    output: { "~standard": props },
    outputJSONSchema: schema.string(),
    schemaSemanticsSHA256: "c".repeat(64),
    effect: "read",
    execute: () => "outer",
  });
  const identity = toolDefinitionSHA256(defined);
  assert.equal(await defined.execute({}), "INNER");
  props.validate = (value) => ({ value: `MUTATED:${value}` });
  await assert.rejects(
    defined.execute({}),
    /cave_tool_output_schema_mismatch:standard_self_delegate/,
  );
  assert.equal(toolDefinitionSHA256(defined), identity);
});

test("Standard output transform receives declared raw result before JSON snapshot", async () => {
  let validations = 0;
  const defined = tool({
    name: "standard_date_output",
    description: "Transform Date output.",
    input: schema.object({}),
    output: {
      "~standard": {
        version: 1,
        vendor: "fixture-date",
        validate(value) {
          validations += 1;
          return value instanceof Date
            ? { value: value.toISOString() }
            : { issues: [{ message: "Date required" }] };
        },
      },
    },
    outputJSONSchema: schema.string(),
    effect: "read",
    execute: () => new Date("2026-08-30T00:00:00.000Z"),
  });
  assert.equal(await defined.execute({}), "2026-08-30T00:00:00.000Z");
  assert.equal(validations, 1);
});

test("declared output serialization ignores inherited toJSON hooks", async () => {
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
  Object.defineProperty(Object.prototype, "toJSON", {
    configurable: true,
    value() {
      return { secret: "PROTO_SECRET" };
    },
  });
  try {
    const defined = tool({
      name: "prototype_to_json",
      description: "Ignore prototype hook.",
      input: schema.object({}),
      output: schema.object({ safe: schema.string() }),
      effect: "read",
      execute: () => ({ safe: "ok" }),
    });
    const settled = await settleToolOutput(defined, { safe: "ok" });
    assert.equal(settled.text, '{"safe":"ok"}');
    assert.doesNotMatch(settled.text, /PROTO_SECRET/);
  } finally {
    if (previous === undefined) delete Object.prototype.toJSON;
    else Object.defineProperty(Object.prototype, "toJSON", previous);
  }
});

test("undeclared outputs retain legacy native JSON serialization", async () => {
  const date = new Date("2026-08-30T00:00:00.000Z");
  const defined = tool({
    name: "legacy_date_output",
    description: "Keep native serialization.",
    input: schema.object({}),
    effect: "read",
    execute: () => date,
  });
  const settled = await settleToolOutput(defined, date);
  assert.equal(settled.value, date);
  assert.equal(settled.text, '"2026-08-30T00:00:00.000Z"');
});

test("mutable validator semantics need explicit digest for lock and durable use", () => {
  const withoutDigest = tool({
    name: "mutable_schema_without_digest",
    description: "Unverified semantics.",
    input: schema.object({}),
    output: {
      "~standard": {
        version: 1,
        vendor: "fixture",
        validate: (value) => ({ value }),
      },
    },
    outputJSONSchema: schema.string(),
    effect: "read",
    execute: () => "ok",
  });
  const withDigest = tool({
    name: "mutable_schema_with_digest",
    description: "Verified semantics.",
    input: schema.object({}),
    output: {
      "~standard": {
        version: 1,
        vendor: "fixture",
        validate: (value) => ({ value }),
      },
    },
    outputJSONSchema: schema.string(),
    schemaSemanticsSHA256: "a".repeat(64),
    effect: "read",
    execute: () => "ok",
  });
  assert.equal(toolSchemaSemanticsVerified(withoutDigest), false);
  assert.equal(toolSchemaSemanticsVerified(withDigest), true);
  assert.notEqual(toolDefinitionSHA256(withoutDigest), toolDefinitionSHA256(withDigest));
});

test("Standard output schema failures remain tool failures", async () => {
  const standardOutput = {
    "~standard": {
      version: 1,
      vendor: "fixture",
      validate() {
        return { issues: [{ message: "no" }] };
      },
    },
  };
  const defined = tool({
    name: "standard_output_invalid",
    description: "Reject output.",
    input: schema.object({}),
    output: standardOutput,
    outputJSONSchema: schema.string(),
    effect: "read",
    execute: () => "wrong",
  });
  await assert.rejects(
    defined.execute({}),
    /cave_tool_output_schema_mismatch:standard_output_invalid/,
  );
});

test("Standard validator failures cannot expose raw output in error text", async () => {
  const defined = tool({
    name: "standard_output_throw",
    description: "Reject output safely.",
    input: schema.object({}),
    output: {
      "~standard": {
        version: 1,
        vendor: "fixture",
        validate(value) {
          throw new Error(`VALIDATOR_LEAK:${value.secret}`);
        },
      },
    },
    outputJSONSchema: schema.object({ secret: schema.string() }),
    effect: "read",
    execute: () => ({ secret: "RAW_SECRET_42" }),
  });
  await assert.rejects(defined.execute({}), (error) => {
    assert.equal(error.message, "cave_tool_output_schema_mismatch:standard_output_throw");
    assert.doesNotMatch(error.message, /RAW_SECRET_42|VALIDATOR_LEAK/);
    return true;
  });
});

test("model-visible serialization cannot run toJSON after validation", async () => {
  let toJSONCalls = 0;
  const defined = tool({
    name: "output_to_json",
    description: "Reject mutable serialization hooks.",
    input: schema.object({}),
    output: schema.object({ value: schema.string() }),
    effect: "read",
    execute() {
      const value = { value: "safe" };
      Object.defineProperty(value, "toJSON", {
        value() {
          toJSONCalls += 1;
          return { secret: "SERIALIZED_SECRET" };
        },
      });
      return value;
    },
  });
  await assert.rejects(
    defined.execute({}),
    /cave_tool_output_schema_mismatch:output_to_json/,
  );
  assert.equal(toJSONCalls, 0);
});

test("output schema configuration fails closed", () => {
  const base = {
    name: "bad_output_contract",
    description: "Bad contract.",
    input: schema.object({}),
    effect: "read",
    execute: () => "value",
  };
  assert.throws(
    () => tool({ ...base, outputJSONSchema: schema.string() }),
    /outputJSONSchema requires a Standard output schema/,
  );
  assert.throws(
    () => tool({ ...base, output: schema.string(), outputJSONSchema: schema.string() }),
    /outputJSONSchema is only valid with Standard Schema/,
  );
  assert.throws(
    () => tool({
      ...base,
      output: {
        "~standard": {
          version: 1,
          vendor: "fixture",
          validate: (value) => ({ value }),
        },
      },
    }),
    /Standard output Schema needs outputJSONSchema/,
  );
});

test("output contract participates in tool identity", () => {
  const make = (output) => tool({
    name: "output_identity",
    description: "Identity.",
    input: schema.object({}),
    ...(output === undefined ? {} : { output }),
    effect: "read",
    execute: () => "value",
  });
  assert.notEqual(
    toolDefinitionSHA256(make(undefined)),
    toolDefinitionSHA256(make(schema.string())),
  );
  assert.notEqual(
    toolDefinitionSHA256(make(schema.string())),
    toolDefinitionSHA256(make(schema.number())),
  );
});

test("Standard output transform semantics participate in tool identity", async () => {
  const make = (mode) => tool({
    name: "standard_output_identity",
    description: "Identity includes transform.",
    input: schema.object({}),
    output: {
      "~standard": {
        version: 1,
        vendor: "fixture",
        validate: mode === "upper"
          ? (value) => ({ value: String(value).toUpperCase() })
          : (value) => ({ value: String(value).toLowerCase() }),
      },
    },
    outputJSONSchema: schema.string(),
    effect: "read",
    execute: () => "MiXeD",
  });
  const upper = make("upper");
  const lower = make("lower");
  assert.equal(await upper.execute({}), "MIXED");
  assert.equal(await lower.execute({}), "mixed");
  assert.notEqual(toolDefinitionSHA256(upper), toolDefinitionSHA256(lower));
});

test("routine preserves TypeBox output validation on optimized path", async () => {
  const original = tool({
    name: "routine_output",
    description: "Return typed data.",
    input: schema.object({}),
    output: schema.object({ value: schema.string() }),
    effect: "read",
    execute: () => ({ value: "original" }),
  });
  const valid = routine(original, () => ({ value: "optimized" }));
  assert.deepEqual(valid.output, original.output);
  assert.deepEqual(await valid.execute({}), { value: "optimized" });

  const invalid = routine(original, () => ({ value: 7 }));
  await assert.rejects(
    invalid.execute({}),
    /cave_tool_output_schema_mismatch:routine_output/,
  );
});

test("routine deopt validates declared output exactly once", async () => {
  const format = `cave-test-${Date.now()}-${Math.random()}`;
  let checks = 0;
  Format.Set(format, () => {
    checks += 1;
    return true;
  });
  const original = tool({
    name: "routine_output_exactly_once",
    description: "Count output checks.",
    input: schema.object({}),
    output: { type: "string", format },
    effect: "read",
    execute: () => "original",
  });
  const defined = routine(original, () => "optimized", { guard: () => false });
  assert.equal(await defined.execute({}), "original");
  assert.equal(checks, 1);
});
