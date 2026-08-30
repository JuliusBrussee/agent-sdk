#!/usr/bin/env node
// Reports exact-pinned upstream dependencies that have moved on the registry.
//
// Informational by design: it always exits 0. A weekly job that goes red the
// first time any of ~20 pins moves is a job that gets muted in a fortnight, and
// then the signal is worth less than nothing. Drift lands in the GitHub step
// summary; Dependabot opens the actual PRs. The hard, offline gate for the
// failure mode Dependabot causes — a devDependency bumped while the mirrored
// peerDependency is left behind — lives in the adapter registry test.
//
//   node scripts/upstream-drift.mjs
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INTERNAL = /^(@caveman-ai|@pebble-agent)\//;
const EXACT = /^\d+\.\d+\.\d+$/;

// Only real workspaces. A fixture or a scaffold template also has a
// package.json, and its pins are product output, not this repo's dependencies.
const workspaceGlobs = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).workspaces;
const workspaceDirs = workspaceGlobs.flatMap((glob) => {
  if (!glob.endsWith("/*")) return [resolve(root, glob)];
  const parent = resolve(root, glob.slice(0, -2));
  if (!existsSync(parent)) return [];
  return readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(parent, entry.name));
});

/** `name@version` -> packages that pin it. */
const pins = new Map();
for (const dir of workspaceDirs) {
  const manifestPath = resolve(dir, "package.json");
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    for (const [name, range] of Object.entries(manifest[field] ?? {})) {
      if (INTERNAL.test(name) || !EXACT.test(range)) continue;
      const key = `${name}@${range}`;
      if (!pins.has(key)) pins.set(key, new Set());
      pins.get(key).add(manifest.name ?? dir);
    }
  }
}

async function latestVersion(name) {
  // Each lookup fails on its own. One DNS blip must not throw away the other
  // twenty results and leave the run indistinguishable from "everything moved".
  try {
    const response = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2f")}/latest`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return { error: `http ${response.status}` };
    return { version: (await response.json()).version };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

const drift = [];
const unavailable = [];
await Promise.all([...pins].map(async ([key, pinners]) => {
  const at = key.lastIndexOf("@");
  const [name, pinned] = [key.slice(0, at), key.slice(at + 1)];
  const result = await latestVersion(name);
  if (result.error !== undefined) {
    unavailable.push({ name, pinned, reason: result.error });
  } else if (result.version !== pinned) {
    drift.push({ name, pinned, latest: result.version, pinners: [...pinners].sort() });
  }
}));
drift.sort((a, b) => a.name.localeCompare(b.name));
unavailable.sort((a, b) => a.name.localeCompare(b.name));

const report = [
  `| pin | latest | held by |`,
  `| --- | --- | --- |`,
  ...drift.map(({ name, pinned, latest, pinners }) =>
    `| \`${name}@${pinned}\` | \`${latest}\` | ${pinners.join(", ")} |`),
];
for (const { name, pinned, latest, pinners } of drift) {
  process.stdout.write(`drift ${name} pinned=${pinned} latest=${latest} in=${pinners.join(",")}\n`);
}
for (const { name, pinned, reason } of unavailable) {
  process.stdout.write(`unavailable ${name} pinned=${pinned} reason=${reason}\n`);
}
process.stdout.write(
  `upstream-drift: ${drift.length} of ${pins.size} exact pins have moved` +
  `${unavailable.length > 0 ? `, ${unavailable.length} could not be checked` : ""}\n`,
);

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `## Upstream drift\n\n${drift.length} of ${pins.size} exact pins have moved.\n\n` +
    `${drift.length > 0 ? report.join("\n") : "_All pins current._"}\n` +
    `${unavailable.length > 0 ? `\n\nCould not check: ${unavailable.map((u) => u.name).join(", ")}\n` : ""}`);
}
