import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// F7: `doctor` recognizes a vercel/eve agent directory and says what maps —
// no import command, no file rewriting; the docs page walks the move.
// Layout facts verified 2026-08-15 against vercel/eve's README and
// docs/reference/project-layout.md: nested `agent/` dir (or flat root) with
// required instructions.md plus eve-only channels/, schedules/,
// connections/, hooks/.

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

async function doctorIn(cwd, args = []) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [cliPath, "doctor", ...args], {
      cwd,
      env: {
        PATH: process.env.PATH,
        // A cold machine, deterministically: no engine, no runtime CLI, and a
        // gateway URL that refuses fast. Doctor must stay WARN-not-FAIL on all
        // three (observe-only still works), so detection is testable offline.
        CAVEMAN_CLI_BIN: "/nonexistent-caveman-cli",
        CAVEMAN_ENGINE_BIN: "/nonexistent-caveman-engine",
        CAVE_GATEWAY_URL: "http://127.0.0.1:9",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("close", (code) => done({
      code,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
}

test("doctor recognizes a nested eve agent directory and says what maps", async () => {
  const base = await mkdtemp(join(tmpdir(), "cave-doctor-eve-"));
  try {
    await mkdir(join(base, "agent/tools"), { recursive: true });
    await mkdir(join(base, "agent/skills"), { recursive: true });
    await mkdir(join(base, "agent/channels"), { recursive: true });
    await mkdir(join(base, "agent/schedules"), { recursive: true });
    await writeFile(join(base, "agent/instructions.md"), "Be helpful.\n");
    await writeFile(join(base, "agent/agent.ts"), "export default {};\n");

    const text = await doctorIn(base);
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, /vercel\/eve agent directory detected \(agent\/ layout, channels\/, schedules\/\)/);
    // The mapping never overstates: what moves, what needs a rewrite, what
    // has no equivalent, and where the walk lives.
    assert.match(text.stdout, /moves as-is\s+instructions\.md/);
    // tools/ and skills/ need their exports/frontmatter rewritten — the
    // doctor must never say they move as-is (Phase-5 gate finding).
    assert.doesNotMatch(text.stdout, /moves as-is[^\n]*tools\//);
    assert.doesNotMatch(text.stdout, /moves as-is[^\n]*skills\//);
    assert.match(text.stdout, /rewrite\s+agent\.ts[^\n]*tools\/\*\.ts[^\n]*skills\/\*\.md/);
    assert.match(text.stdout, /no equivalent\s+channels\/ · schedules\//);
    assert.match(text.stdout, /Vercel Connect credentials are not supported/);
    assert.match(text.stdout, /docs\/eve-migration\.md/);

    const json = await doctorIn(base, ["--json"]);
    assert.equal(json.code, 0, json.stderr);
    const report = JSON.parse(json.stdout);
    assert.deepEqual(report.eve_migration, {
      agent_dir: "agent",
      eve_only: ["channels/", "schedules/"],
      maps: ["instructions.md", "agent.ts", "tools/", "skills/"],
    });
    assert.equal(
      report.checks.some((check) => check.id === "eve_migration" && check.status === "warn"),
      true,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("a flat directory without eve-only markers is NOT called eve — the overlap IS the convention", async () => {
  const base = await mkdtemp(join(tmpdir(), "cave-doctor-flat-"));
  try {
    await mkdir(join(base, "tools"), { recursive: true });
    await mkdir(join(base, "skills"), { recursive: true });
    await writeFile(join(base, "instructions.md"), "Be helpful.\n");

    const json = await doctorIn(base, ["--json"]);
    const report = JSON.parse(json.stdout);
    assert.equal("eve_migration" in report, false);
    assert.doesNotMatch(json.stdout, /vercel\/eve/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("a caveman.config.ts project is never flagged, whatever else it contains", async () => {
  const base = await mkdtemp(join(tmpdir(), "cave-doctor-native-"));
  try {
    await mkdir(join(base, "channels"), { recursive: true });
    await mkdir(join(base, "hooks"), { recursive: true });
    await writeFile(join(base, "instructions.md"), "Be helpful.\n");
    await writeFile(join(base, "caveman.config.ts"), "export default {};\n");

    const json = await doctorIn(base, ["--json"]);
    const report = JSON.parse(json.stdout);
    assert.equal("eve_migration" in report, false);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
