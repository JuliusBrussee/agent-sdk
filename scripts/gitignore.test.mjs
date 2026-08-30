import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function ignored(path) {
  const result = spawnSync(
    "git",
    ["-C", REPOSITORY_ROOT, "check-ignore", "--quiet", "--no-index", path],
    { encoding: "utf8" },
  );
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(result.stderr || `git check-ignore exited ${result.status}`);
  }
  return result.status === 0;
}

test("dependencies, generated output, local state, and credentials stay ignored", () => {
  for (const path of [
    "node_modules/example/index.js",
    "packages/agent/dist/index.js",
    "packages/agent/tsconfig.tsbuildinfo",
    "release/package.tgz",
    "coverage/index.html",
    "test-results/results.json",
    ".caveman/runs/receipt.json",
    ".cache/npm/debug.log",
    ".env.local",
    "packages/example/.env.production",
    ".npmrc",
    ".claude/settings.local.json",
    ".idea/workspace.xml",
    ".vscode/settings.json",
    "scratch.tmp",
  ]) {
    assert.equal(ignored(path), true, `${path} must be ignored`);
  }
});

test("examples, hooks, source, and deliberate log fixtures remain trackable", () => {
  for (const path of [
    ".env.example",
    ".env.production.example",
    "packages/example/.env.test.example",
    ".githooks/pre-push",
    ".claude/commands/review.md",
    "packages/agent/src/index.ts",
    "packages/agent/tests/fixtures/provider.log",
    "packages/agent/goldens/runtime.log",
  ]) {
    assert.equal(ignored(path), false, `${path} must remain trackable`);
  }
});

test("tracked files never depend on ignore precedence", () => {
  const output = execFileSync(
    "git",
    ["-C", REPOSITORY_ROOT, "ls-files", "-ci", "--exclude-standard"],
    { encoding: "utf8" },
  ).trim();
  assert.equal(output, "");
});
