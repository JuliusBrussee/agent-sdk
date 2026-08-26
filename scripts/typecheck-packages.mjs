#!/usr/bin/env node

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const executable = process.platform === "win32" ? "tsc.cmd" : "tsc";
const candidates = [
  resolve(root, "node_modules/.bin", executable),
  resolve(root, "packages/agent/node_modules/.bin", executable),
];
const tsc = candidates.find((candidate) => existsSync(candidate));
if (tsc === undefined) {
  throw new Error("package typecheck needs npm ci at repository root or packages/agent");
}

const result = spawnSync(tsc, ["--project", resolve(root, "tsconfig.packages.json")], {
  cwd: root,
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
