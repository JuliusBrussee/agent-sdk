import assert from "node:assert/strict";
import test from "node:test";
import { CODING_AGENT_HELP, parseCodingAgentCLIArgs } from "../src/cli-args.js";
import { main } from "../src/cli.js";

test("CLI parses product boundary options", () => {
  assert.deepEqual(parseCodingAgentCLIArgs([
    "--workspace", "/tmp/work",
    "--model", "anthropic/claude-sonnet-5",
    "--observe-only",
    "--max-cost-usd", "0.25",
    "--no-start-runtime",
  ]), {
    help: false,
    workspace: "/tmp/work",
    model: "anthropic/claude-sonnet-5",
    cave: "off",
    maxCostUsd: 0.25,
    ensureRuntime: false,
  });
  assert.throws(
    () => parseCodingAgentCLIArgs(["--max-cost-usd", "0"]),
    /--max-cost-usd must be positive/,
  );
  assert.throws(() => parseCodingAgentCLIArgs(["--wat"]), /unknown option --wat/);
});

test("help does not load framework runtime", async () => {
  let output = "";
  const result = await main(["--help"], {
    stdout: { write: (value) => { output += value; } },
    stderr: { write: () => assert.fail("help wrote stderr") },
  });
  assert.equal(result, undefined);
  assert.equal(output, `${CODING_AGENT_HELP}\n`);
});

test("CLI forwards parsed options to coding runtime", async () => {
  const calls = [];
  const runtime = {
    createCodingAgent(options) {
      calls.push(["create", options]);
      return { kind: "fixture-agent" };
    },
    async runCodingSession(options) {
      calls.push(["run", options]);
      return { turns: 0 };
    },
  };
  const stdout = { write() {} };
  const stderr = { write() {} };
  const result = await main(
    ["--workspace", "/work", "--observe-only", "--max-cost-usd", "0.1"],
    { stdout, stderr },
    runtime,
  );
  assert.deepEqual(calls[0], ["create", { workspace: "/work" }]);
  assert.deepEqual(calls[1], ["run", {
    agent: { kind: "fixture-agent" },
    cave: "off",
    maxCostUsd: 0.1,
    output: stdout,
    notice: stderr,
  }]);
  assert.deepEqual(result, { turns: 0 });
});
