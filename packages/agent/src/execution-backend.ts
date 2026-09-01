/**
 * Execution backend HTTP contract
 *
 * Every request is POST with `Authorization: Bearer <token>` and
 * `Content-Type: application/json`.
 *
 * - `/exec`: request `{ command, args, cwd, env, timeoutMs, maxOutputBytes }`;
 *   response `{ stdout, stderr, code, timedOut, truncated }`.
 * - `/read`: request `{ path, maxBytes? }`; response `{ data }`, where `data`
 *   is base64. A missing path returns HTTP 404.
 * - `/write`: request `{ path, data }`, where `data` is base64; response `{}`.
 * - Optional `/prepare`: request `{}`; response `{}`.
 * - Optional `/snapshot`: request `{}`; response `{ snapshotId }`.
 * - Optional `/restore`: request `{ snapshotId }`; response `{}`.
 *
 * Non-2xx responses fail closed. `AbortSignal` is transport-local and is not
 * serialized; the HTTP client passes it to fetch for `/exec` cancellation.
 * Server enforces its workspace root for paths, including symlink targets.
 */
import { spawn } from "node:child_process";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { killProcessTree, portableInvocation } from "./portable-process.js";

export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
  readonly timedOut: boolean;
  readonly truncated: boolean;
}

export interface ExecRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
}

export interface ExecutionBackend {
  readonly id: string;
  exec(request: ExecRequest): Promise<ExecResult>;
  readFile(path: string, opts?: { maxBytes?: number }): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  prepare?(): Promise<void>;
  snapshot?(): Promise<string>;
  restore?(snapshotId: string): Promise<void>;
  close?(): Promise<void>;
}

const LOCAL_INTERNALS = Symbol.for("@caveman-ai/agent/execution-backend-local-internals");
const EXIT_FLUSH_GRACE_MS = 100;

type LocalInternals = {
  resolvePath(workspace: string, candidate: string): Promise<string>;
  isFile(path: string): Promise<boolean>;
  writeFile(path: string, data: Uint8Array, exclusive: boolean): Promise<void>;
};

export function localExecutionBackend(): ExecutionBackend {
  const workspaceRoots = new Map<string, Promise<string>>();
  const internals: LocalInternals = {
    resolvePath(workspace, candidate) {
      let root = workspaceRoots.get(workspace);
      if (root === undefined) {
        root = realpath(workspace);
        workspaceRoots.set(workspace, root);
      }
      return root.then(async (canonicalWorkspace) => {
        const target = await canonicalizePath(resolve(canonicalWorkspace, candidate));
        if (escapesRoot(relative(canonicalWorkspace, target))) {
          throw new Error(`caveman-code: path escapes the workspace: ${candidate}`);
        }
        return target;
      });
    },
    async isFile(path) {
      return (await stat(path)).isFile();
    },
    async writeFile(path, data, exclusive) {
      await writeFile(path, data, { flag: exclusive ? "wx" : "w" });
    },
  };
  return {
    id: "local",
    exec: localExec,
    readFile: (path, opts) => readFile(path).then((data) => boundedBytes(data, opts?.maxBytes)),
    writeFile: (path, data) => writeFile(path, data),
    [LOCAL_INTERNALS]: internals,
  } as ExecutionBackend;
}

export function httpExecutionBackend(opts: {
  url: string;
  token: string;
  fetch?: typeof fetch;
}): ExecutionBackend {
  const url = opts.url.replace(/\/+$/, "");
  if (url === "") throw new Error("cave_execution_backend_http_url_required");
  if (opts.token === "") throw new Error("cave_execution_backend_http_token_required");
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const post = async (endpoint: string, body: unknown, signal?: AbortSignal): Promise<unknown> => {
    const response = await fetchImpl(`${url}/${endpoint}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${opts.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) {
      const error = new Error(`cave_execution_backend_http_${endpoint}_failed:${response.status}`) as
        NodeJS.ErrnoException;
      if (endpoint === "read" && response.status === 404) error.code = "ENOENT";
      throw error;
    }
    const text = await response.text();
    return text === "" ? {} : JSON.parse(text) as unknown;
  };
  return {
    id: "http",
    async exec(request) {
      const response = await post("exec", {
        command: request.command,
        args: request.args,
        cwd: request.cwd,
        env: request.env,
        timeoutMs: request.timeoutMs,
        maxOutputBytes: request.maxOutputBytes,
      }, request.signal);
      return validateExecResult(response, request.maxOutputBytes);
    },
    async readFile(path, readOpts) {
      const response = objectResponse(await post("read", {
        path,
        ...(readOpts?.maxBytes === undefined ? {} : { maxBytes: readOpts.maxBytes }),
      }), "read");
      if (typeof response.data !== "string") {
        throw new Error("cave_execution_backend_http_read_invalid");
      }
      return boundedBytes(Buffer.from(response.data, "base64"), readOpts?.maxBytes);
    },
    async writeFile(path, data) {
      await post("write", { path, data: Buffer.from(data).toString("base64") });
    },
    async prepare() {
      await post("prepare", {});
    },
    async snapshot() {
      const response = objectResponse(await post("snapshot", {}), "snapshot");
      if (typeof response.snapshotId !== "string" || response.snapshotId === "") {
        throw new Error("cave_execution_backend_http_snapshot_invalid");
      }
      return response.snapshotId;
    },
    async restore(snapshotId) {
      await post("restore", { snapshotId });
    },
  };
}

async function localExec(request: ExecRequest): Promise<ExecResult> {
  let invocation;
  try {
    invocation = portableInvocation(request.command, request.args, { env: request.env });
  } catch (error) {
    return spawnFailure(error);
  }
  return new Promise((accept) => {
    let child;
    try {
      child = spawn(invocation.command, [...invocation.args], {
        cwd: request.cwd,
        env: { ...request.env },
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
    } catch (error) {
      accept(spawnFailure(error));
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let exitCode: number | null = null;
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      const remaining = request.maxOutputBytes - bytes;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      if (chunk.byteLength > remaining) truncated = true;
      const kept = chunk.subarray(0, remaining);
      bytes += kept.byteLength;
      target.push(kept);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    const kill = () => killProcessTree(child);
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, request.timeoutMs);
    const abort = () => kill();
    request.signal?.addEventListener("abort", abort, { once: true });
    if (request.signal?.aborted === true) abort();
    const settle = (result: ExecResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", abort);
      accept(result);
    };
    const finish = () => {
      child.stdout.destroy();
      child.stderr.destroy();
      settle({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        code: exitCode,
        timedOut,
        truncated,
      });
    };
    child.once("error", (error) => settle(spawnFailure(error)));
    child.once("close", (code) => {
      exitCode = code;
      finish();
    });
    child.once("exit", (code) => {
      exitCode = code;
      setTimeout(finish, EXIT_FLUSH_GRACE_MS).unref();
    });
  });
}

function spawnFailure(error: unknown): ExecResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    stdout: "",
    stderr: `cave_execution_backend_spawn_failed:${message}`,
    code: null,
    timedOut: false,
    truncated: false,
  };
}

function validateExecResult(value: unknown, maxOutputBytes: number): ExecResult {
  const result = objectResponse(value, "exec");
  if (typeof result.stdout !== "string" || typeof result.stderr !== "string" ||
      (typeof result.code !== "number" && result.code !== null) ||
      typeof result.timedOut !== "boolean" || typeof result.truncated !== "boolean") {
    throw new Error("cave_execution_backend_http_exec_invalid");
  }
  const stdout = boundedText(result.stdout, maxOutputBytes);
  const remaining = Math.max(0, maxOutputBytes - Buffer.byteLength(stdout, "utf8"));
  const stderr = boundedText(result.stderr, remaining);
  const truncated = result.truncated || stdout !== result.stdout || stderr !== result.stderr;
  return { stdout, stderr, code: result.code, timedOut: result.timedOut, truncated };
}

function objectResponse(value: unknown, endpoint: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`cave_execution_backend_http_${endpoint}_invalid`);
  }
  return value as Record<string, unknown>;
}

function boundedText(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  return bytes.byteLength <= maxBytes ? value : bytes.subarray(0, maxBytes).toString("utf8");
}

function boundedBytes(value: Uint8Array, maxBytes: number | undefined): Uint8Array {
  return maxBytes === undefined || value.byteLength <= maxBytes
    ? value
    : value.subarray(0, maxBytes);
}

async function canonicalizePath(target: string): Promise<string> {
  const missing: string[] = [];
  let current = target;
  for (;;) {
    try {
      const canonical = await realpath(current);
      return missing.length === 0 ? canonical : resolve(canonical, ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

function escapesRoot(path: string): boolean {
  return path === ".." || path.startsWith("../") || path.startsWith("..\\") || isAbsolute(path);
}
