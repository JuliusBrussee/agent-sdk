#!/usr/bin/env node

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cache = resolve(root, ".cache/npm");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const packages = ["packages/agent", "packages/create-caveman-agent"];

mkdirSync(cache, { recursive: true });

for (const packagePath of packages) {
  const result = spawnSync(
    npm,
    ["pack", "--dry-run", "--ignore-scripts", "--json"],
    {
      cwd: resolve(root, packagePath),
      env: { ...process.env, npm_config_cache: cache },
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
