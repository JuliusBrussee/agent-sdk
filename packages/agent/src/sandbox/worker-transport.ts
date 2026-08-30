/**
 * Everything about talking to a contained tool worker that is not the agent
 * loop: the read grants it is spawned with, the authenticated result frame it
 * answers on, the reaping of detached children, and the redaction applied to
 * whatever it printed on the way out.
 *
 * Split out of `runtime.ts` so the sandbox transport can be read, reviewed, and
 * tested as one thing. None of it knows what an agent is.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { dirname, relative, resolve } from "node:path";
import type { ChildProcess } from "node:child_process";
import { killProcessTree } from "../portable-process.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** True when `path` (a relative path) leaves the directory it is relative to. */
function escapesRoot(path: string): boolean {
  return path === ".." || path.startsWith(`..${"/"}`) || path.startsWith(`..${"\\"}`);
}

/**
 * Above this many per-file `--allow-fs-read` flags, collapse the staged source
 * files to their common ancestor directory. A large project would
 * otherwise blow the OS argument limit (E2BIG) and the tool could not spawn at
 * all. The collapse is safe here: `sourceFiles` are paths inside the per-run
 * STAGED COPY, which already contains only the reachable source graph — never
 * the real project root with its .env and credentials.
 */
const SANDBOX_FS_READ_FLAG_THRESHOLD = 1024;

function commonAncestorDir(paths: readonly string[]): string {
  const dirs = paths.map((path) => resolve(dirname(path)));
  const first = dirs[0];
  if (first === undefined) {
    throw new Error("cave_sandbox_source_staging_root_required");
  }
  let ancestor = first;
  while (dirs.some((path) => escapesRoot(relative(ancestor, path)))) {
    const parent = dirname(ancestor);
    if (parent === ancestor) {
      throw new Error("cave_sandbox_source_read_root_refused");
    }
    ancestor = parent;
  }
  if (dirname(ancestor) === ancestor) {
    throw new Error("cave_sandbox_source_read_root_refused");
  }
  return ancestor;
}

export function sandboxSourceReadFlags(
  sourceFiles: readonly string[],
  stagingRoot?: string,
): string[] {
  if (sourceFiles.length <= SANDBOX_FS_READ_FLAG_THRESHOLD) {
    return sourceFiles.map((path) => `--allow-fs-read=${path}`);
  }
  if (stagingRoot === undefined) {
    throw new Error("cave_sandbox_source_staging_root_required");
  }
  const resolvedStagingRoot = resolve(stagingRoot);
  if (dirname(resolvedStagingRoot) === resolvedStagingRoot) {
    throw new Error("cave_sandbox_source_read_root_refused");
  }
  const ancestor = commonAncestorDir(sourceFiles);
  if (escapesRoot(relative(resolvedStagingRoot, ancestor))) {
    throw new Error("cave_sandbox_source_read_grant_escapes_staging");
  }
  return [`--allow-fs-read=${ancestor}`];
}

/** Decode the length-prefixed result frame delivered on the worker's fd 3. */
export type SandboxResultFrame =
  | { ok: true; settled: true; value?: unknown; text: string }
  | { ok: false; code?: string };

export function decodeResultFrame(
  buffer: Buffer,
  authenticationKey: string,
): SandboxResultFrame | undefined {
  if (buffer.byteLength < 36) return undefined;
  const length = buffer.readUInt32BE(0);
  if (buffer.byteLength !== 36 + length) return undefined;
  const tag = buffer.subarray(4, 36);
  const body = buffer.subarray(36);
  const expected = createHmac("sha256", authenticationKey).update(body).digest();
  if (!timingSafeEqual(tag, expected)) return undefined;
  try {
    const parsed = JSON.parse(body.toString("utf8")) as unknown;
    if (!isRecord(parsed) || typeof parsed.ok !== "boolean") return undefined;
    const keys = Object.keys(parsed).sort();
    if (parsed.ok) {
      if (keys.some((key) => !["ok", "settled", "text", "value"].includes(key)) ||
          parsed.settled !== true || typeof parsed.text !== "string") {
        return undefined;
      }
      return parsed as unknown as SandboxResultFrame;
    }
    if (keys.some((key) => key !== "ok" && key !== "code") ||
        (parsed.code !== undefined && typeof parsed.code !== "string")) {
      return undefined;
    }
    return parsed as unknown as SandboxResultFrame;
  } catch {
    return undefined;
  }
}

// Every live sandbox child (spawned detached, so it outlives an ungraceful
// parent exit). Reaped on parent exit and on a catchable termination signal so a
// SIGINT/SIGTERM does not strand detached tool process groups forever.
export const liveSandboxChildren = new Set<ChildProcess>();
let sandboxReapingInstalled = false;
export function installSandboxReaping(): void {
  if (sandboxReapingInstalled) return;
  sandboxReapingInstalled = true;
  const reap = (): void => {
    for (const child of liveSandboxChildren) killSandboxProcess(child, "SIGKILL");
    liveSandboxChildren.clear();
  };
  process.on("exit", reap);
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    const handler = (): void => {
      reap();
      // Non-intrusive: defer to the host's own handler if it has one; otherwise
      // restore the default action (terminate) by re-raising.
      process.removeListener(sig, handler);
      if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
    };
    process.on(sig, handler);
  }
}

export function killSandboxProcess(
  child: ChildProcess,
  signal: NodeJS.Signals,
): void {
  killProcessTree(child, signal);
}

export function redactSandboxError(value: string): string {
  return value
    .replaceAll(process.env.HOME ?? "\u0000", "<home>")
    .replace(/[A-Za-z0-9_=-]{24,}/g, "<redacted>")
    .slice(0, 512);
}
