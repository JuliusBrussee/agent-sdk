import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePebbleSpineArgs } from "../dist/pebble-cli.js";

test("Pebble spine CLI parses headless JSON mode and fails closed on unknown args", () => {
  assert.deepEqual(parsePebbleSpineArgs([
    "-p",
    "list files here",
    "--json",
    "--cave-off",
    "--model",
    "anthropic/claude-sonnet-4-6",
  ]), {
    prompt: "list files here",
    json: true,
    cave: "off",
    model: "anthropic/claude-sonnet-4-6",
  });
  assert.throws(() => parsePebbleSpineArgs(["--wat"]), /pebble_unknown_argument/);
  assert.throws(() => parsePebbleSpineArgs(["--json"]), /pebble_prompt_required/);
});

