#!/usr/bin/env node

import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const examplesRoot = resolve(repositoryRoot, "examples");
const currentNodeMajor = Number(process.versions.node.split(".")[0]);
const requireAll = process.env.CAVE_SAMPLE_REQUIRE_ALL === "1";

const packages = discoverPackages(examplesRoot).map((path) => {
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  const directory = dirname(path);
  const metadata = manifest.cavemanSample;
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata) ||
      !Number.isSafeInteger(metadata.minNodeMajor) || metadata.minNodeMajor < 22 ||
      typeof metadata.workflow !== "string" || metadata.workflow.trim() === "" ||
      manifest.private !== true || typeof manifest.scripts?.test !== "string" ||
      typeof manifest.scripts?.build !== "string") {
    throw new Error(`sample_manifest_invalid:${relative(repositoryRoot, path)}`);
  }
  return { directory, manifest, metadata };
});

if (packages.length === 0) throw new Error("sample_packages_missing");

let executed = 0;
let skipped = 0;
for (const sample of packages) {
  const name = sample.manifest.name ?? relative(repositoryRoot, sample.directory);
  if (currentNodeMajor < sample.metadata.minNodeMajor) {
    const message = `sample SKIP ${name}: requires Node ${sample.metadata.minNodeMajor}+; current ${process.versions.node}`;
    if (requireAll) throw new Error(message);
    process.stdout.write(`${message}\n`);
    skipped += 1;
    continue;
  }
  process.stdout.write(`sample RUN  ${name}: ${sample.metadata.workflow}\n`);
  const result = spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["--prefix", sample.directory, "test"],
    { cwd: repositoryRoot, stdio: "inherit", env: process.env },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`sample_test_failed:${name}:${result.status ?? "signal"}`);
  }
  executed += 1;
}

process.stdout.write(`samples: ${executed} executed, ${skipped} explicit Node-version skips\n`);

function discoverPackages(root) {
  const found = [];
  visit(root, 0, found);
  return found.sort();
}

function visit(directory, depth, found) {
  if (depth > 4) throw new Error(`sample_directory_depth_exceeded:${relative(examplesRoot, directory)}`);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (["node_modules", "dist", ".caveman", ".data"].includes(entry.name) ||
        entry.name.startsWith("_")) continue;
    const path = resolve(directory, entry.name);
    if (entry.isFile() && entry.name === "package.json") found.push(path);
    if (entry.isDirectory()) visit(path, depth + 1, found);
  }
}
