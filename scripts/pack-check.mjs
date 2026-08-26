#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cache = resolve(root, ".cache/npm");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const fixedPackages = [
  "packages/agent",
  "packages/adapter-kit",
  "packages/coding-agent",
  "packages/create-caveman-agent",
  "packages/pebble-protocol",
];
const adaptersRoot = resolve(root, "packages/adapters");
const adapterPackages = readdirSync(adaptersRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => `packages/adapters/${entry.name}`)
  .filter((packagePath) => existsSync(resolve(root, packagePath, "package.json")))
  .sort();
const packages = [...fixedPackages, ...adapterPackages];

mkdirSync(cache, { recursive: true });
const packDestination = mkdtempSync(join(tmpdir(), "caveman-pack-check-"));

function declaredBinPaths(packagePath) {
  const manifest = JSON.parse(readFileSync(resolve(root, packagePath, "package.json"), "utf8"));
  if (typeof manifest.bin === "string") return [manifest.bin];
  if (manifest.bin === undefined) return [];
  if (manifest.bin === null || typeof manifest.bin !== "object" || Array.isArray(manifest.bin)) {
    throw new Error(`pack_check_bin_manifest_invalid:${packagePath}`);
  }
  return Object.values(manifest.bin);
}

try {
  for (const packagePath of packages) {
    const result = spawnSync(
      npm,
      ["pack", "--ignore-scripts", "--json", "--pack-destination", packDestination],
      {
        cwd: resolve(root, packagePath),
        encoding: "utf8",
        env: { ...process.env, npm_config_cache: cache },
      },
    );
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const failure = result.signal ?? result.status ?? "unknown";
      throw new Error(`pack_check_command_failed:${packagePath}:${failure}`);
    }

    const records = JSON.parse(result.stdout);
    if (!Array.isArray(records) || records.length !== 1) {
      throw new Error(`pack_check_record_invalid:${packagePath}`);
    }
    const [{ filename, size }] = records;
    if (typeof filename !== "string" || filename !== basename(filename)) {
      throw new Error(`pack_check_filename_invalid:${packagePath}`);
    }
    const archive = resolve(packDestination, filename);
    if (!existsSync(archive) || statSync(archive).size !== size) {
      throw new Error(`pack_check_archive_invalid:${packagePath}`);
    }
    for (const rawBinPath of declaredBinPaths(packagePath)) {
      if (typeof rawBinPath !== "string" || rawBinPath.length === 0) {
        throw new Error(`pack_check_bin_manifest_invalid:${packagePath}`);
      }
      const binPath = rawBinPath.replace(/^\.\//, "");
      const packedBin = records[0].files?.find((file) => file.path === binPath);
      if (packedBin === undefined) {
        throw new Error(`pack_check_bin_missing:${packagePath}:${binPath}`);
      }
      if (!Number.isSafeInteger(packedBin.mode) || (packedBin.mode & 0o111) === 0) {
        throw new Error(`pack_check_bin_not_executable:${packagePath}:${binPath}`);
      }
    }
  }
} finally {
  rmSync(packDestination, { recursive: true, force: true });
}
