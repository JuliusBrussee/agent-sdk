#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const EXPECTED_REPOSITORY = "JuliusBrussee/agent-sdk";
export const EXPECTED_REMOTE_URL = `https://github.com/${EXPECTED_REPOSITORY}.git`;

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), "..");

export function repositoryFromRemoteUrl(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const remote = value.trim();
  const scp = /^git@github\.com:([^/?#]+)\/([^/?#]+?)(?:\.git)?\/?$/.exec(remote);
  if (scp !== null) return `${scp[1]}/${scp[2]}`;

  let parsed;
  try {
    parsed = new URL(remote);
  } catch {
    return null;
  }
  if (parsed.hostname.toLowerCase() !== "github.com" ||
      (parsed.protocol !== "https:" && parsed.protocol !== "ssh:") ||
      parsed.port !== "" ||
      parsed.search !== "" || parsed.hash !== "") {
    return null;
  }
  if (parsed.protocol === "ssh:" && parsed.username !== "git") return null;
  if (parsed.protocol === "https:" &&
      (parsed.username !== "" || parsed.password !== "")) return null;
  const parts = parsed.pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length !== 2 || parts.some((part) => part === "")) return null;
  parts[1] = parts[1].replace(/\.git$/, "");
  return parts[1] === "" ? null : `${parts[0]}/${parts[1]}`;
}

export function assertRepositoryRemote(value, label = "remote") {
  const actual = repositoryFromRemoteUrl(value);
  if (actual === EXPECTED_REPOSITORY) return;
  const rendered = actual === null ? "unrecognized remote URL" : actual;
  throw new Error([
    "repository_identity_mismatch",
    `Expected: ${EXPECTED_REPOSITORY}`,
    `Refused ${label}: ${rendered}`,
    "This checkout may push only to its canonical GitHub repository.",
  ].join("\n"));
}

function git(...args) {
  return execFileSync("git", ["-C", REPOSITORY_ROOT, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function configuredUrls(kind) {
  const args = kind === "push"
    ? ["remote", "get-url", "--push", "--all", "origin"]
    : ["remote", "get-url", "--all", "origin"];
  const output = git(...args);
  if (output === "") throw new Error(`repository_identity_${kind}_remote_missing`);
  return output.split("\n").filter(Boolean);
}

export function checkConfiguredRepository() {
  for (const [kind, urls] of [
    ["fetch", configuredUrls("fetch")],
    ["push", configuredUrls("push")],
  ]) {
    for (const value of urls) assertRepositoryRemote(value, `${kind} URL`);
  }
}

function installHookPath() {
  git("config", "--local", "core.hooksPath", ".githooks");
  const configured = git("config", "--local", "--get", "core.hooksPath");
  if (configured !== ".githooks") {
    throw new Error(`repository_identity_hook_install_failed:${configured}`);
  }
}

function usage() {
  return [
    "Usage:",
    "  node scripts/check-repository-identity.mjs",
    "  node scripts/check-repository-identity.mjs --install",
    "  node scripts/check-repository-identity.mjs --push-url URL",
  ].join("\n");
}

function main(args) {
  if (args.includes("--help")) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (args[0] === "--push-url" && args.length === 2) {
    assertRepositoryRemote(args[1], "push destination");
    process.stdout.write(`repository-identity: OK — ${EXPECTED_REPOSITORY}\n`);
    return;
  }
  if (args.length === 1 && args[0] === "--install") {
    checkConfiguredRepository();
    installHookPath();
    process.stdout.write(
      `repository-identity: OK — ${EXPECTED_REPOSITORY}; pre-push hook active\n`,
    );
    return;
  }
  if (args.length !== 0) throw new Error(usage());
  checkConfiguredRepository();
  process.stdout.write(`repository-identity: OK — ${EXPECTED_REPOSITORY}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(SCRIPT_PATH)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
