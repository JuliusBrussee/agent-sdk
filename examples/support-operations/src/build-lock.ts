import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { parseSupportBuild } from "./agent.js";

const execFileAsync = promisify(execFile);

/** Run repository-supported freshness check before loading production lock. */
export async function loadCurrentSupportBuild(rootDir: string) {
  try {
    await execFileAsync("caveman-agent", ["check", "caveman.config.ts"], {
      cwd: rootDir,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 2 << 20,
      env: subprocessEnvironment(),
    });
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    const detail = `${failure.stderr ?? ""}\n${failure.stdout ?? ""}`.trim().slice(0, 2_000);
    throw new Error(
      `support_optimization_build_not_current${detail === "" ? "" : `: ${detail}`}`,
      { cause: error },
    );
  }
  return parseSupportBuild(JSON.parse(await readFile(
    resolve(rootDir, ".caveman/agent.lock.json"),
    "utf8",
  )));
}

function subprocessEnvironment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of [
    "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SystemRoot", "ComSpec", "PATHEXT",
    "CAVEMAN_ENGINE_BIN",
  ]) {
    const value = process.env[name];
    if (value !== undefined) result[name] = value;
  }
  return result;
}
