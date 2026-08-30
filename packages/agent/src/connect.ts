import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { schema, tool, type ToolDefinition } from "./primitives.js";
import { FRAMEWORK_VERSION } from "./runtime-identity.js";
import {
  snapshotDataDictionary,
  snapshotDataRecord,
  snapshotDenseArray,
} from "./strict-data.js";

const DEFAULT_CAPTURE_BYTES = 8 * 1024 * 1024;
const DEFAULT_RESULT_BYTES = 24 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const CONNECT_TOOL_LIST_MAX_PAGES = 32;
const CONNECT_TOOL_LIST_MAX_TOOLS = 1_024;
const CONNECT_TOOL_LIST_MAX_BYTES = 1024 * 1024;
const CONNECT_TOOL_LIST_MAX_CURSOR_BYTES = 4 * 1024;
const CONNECT_TOOL_LIST_MAX_JSON_DEPTH = 64;
const CONNECT_TOOL_LIST_MAX_JSON_NODES = 100_000;
const CONNECT_BOOTSTRAP_QUERY = "__caveman_agent_mcp_bootstrap__";
const CONNECT_ACTION_BIND_MAX_KEYS = 32;
const CONNECT_ACTION_INPUT_MAX_DEPTH = 32;
const CONNECT_ACTION_UNKNOWN_OUTCOME_MAX = 256;
const CONNECT_COMMANDS = new Set([
  "serve",
  "start",
  "stop",
  "connect",
  "providers",
  "connections",
  "disconnect",
  "open",
  "status",
  "doctor",
  "audit",
  "agent",
  "secret",
  "mcp",
  "version",
]);

const CONNECT_ENV_ALLOWLIST = [
  "HOME",
  "USER",
  "LOGNAME",
  "PATH",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "TERM",
  "NO_COLOR",
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "CAVE_CONNECT_HOST",
  "CAVE_CONNECT_PORT",
  "CAVE_CONNECT_DATA_DIR",
  "CAVE_CONNECT_RELAY_URL",
  "CAVE_CONNECT_FIXED_CALLBACK_PROVIDERS",
  "CAVE_CONNECT_DEVICE_CODE_OVERRIDES",
  "CAVE_CONNECT_NODE",
  "CAVE_CONNECT_ACTION_CONCURRENCY",
  "CAVE_CONNECT_RUNTIME_DIR",
] as const;

export interface ConnectProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ConnectExecuteOptions {
  readonly environment: Readonly<Record<string, string>>;
  readonly capture: boolean;
  readonly input?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
  readonly maxCaptureBytes: number;
  readonly onOutput?: (value: string, stream: "stdout" | "stderr") => void;
}

export type ConnectExecutor = (
  binary: string,
  args: readonly string[],
  options: ConnectExecuteOptions,
) => Promise<ConnectProcessResult>;

export interface ConnectRuntimeOptions {
  /** Absolute path preferred. Otherwise CAVE_CONNECT_BIN, then PATH is checked. */
  readonly binary?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly execute?: ConnectExecutor;
  readonly maxCaptureBytes?: number;
  readonly timeoutMs?: number;
}

export interface ConnectMcpCallResult {
  readonly isError: boolean;
  readonly structuredContent: unknown;
  readonly content: readonly unknown[];
}

/** Credential-free saved-connection projection returned by cave-connectd. */
export interface ConnectConnection {
  readonly connectionId: string;
  readonly provider: string;
  readonly authMode: string;
  readonly status: string;
}

export interface ConnectMcpToolIcon {
  readonly src: string;
  readonly mimeType?: string;
  readonly sizes?: readonly string[];
  readonly theme?: "light" | "dark";
}

export interface ConnectMcpToolAnnotations {
  readonly title?: string;
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

export interface ConnectMcpToolExecution {
  readonly taskSupport?: "forbidden" | "optional" | "required";
}

/** Detached, deeply frozen MCP tool descriptor. Annotation values remain hints. */
export interface ConnectMcpTool {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  readonly annotations?: ConnectMcpToolAnnotations;
  readonly execution?: ConnectMcpToolExecution;
  readonly icons?: readonly ConnectMcpToolIcon[];
  readonly _meta?: Readonly<Record<string, unknown>>;
}

/** Values trusted config may fix on an action. Must stay serializable. */
export type ConnectActionBindValue = string | number | boolean | null;

export interface ConnectAction {
  /** Curated provider action name. */
  readonly name: string;
  /** Argument values fixed by config. Model input may not set these keys. */
  readonly bind?: Readonly<Record<string, ConnectActionBindValue>>;
}

export interface NormalizedConnectAction {
  readonly name: string;
  readonly bind: Readonly<Record<string, ConnectActionBindValue>>;
}

export interface ConnectSource {
  /** Short agent-facing name, for example "work-github". */
  readonly id: string;
  /** Caveman Connect provider slug. */
  readonly provider: string;
  /** Optional exact saved connection. Omit only when provider has exactly one active connection. */
  readonly connectionId?: string;
  /** Syncs agent may trigger. Empty/omitted means read existing records only. */
  readonly collect?: readonly string[];
  /** Record models agent may read. Empty/omitted means any model under this allowed connection. */
  readonly models?: readonly string[];
  /**
   * Curated provider actions agent may execute. Default none. A bare string
   * lets the model choose every argument; the object form fixes destination or
   * credential-shaped arguments in trusted config instead.
   */
  readonly actions?: readonly (string | ConnectAction)[];
}

export interface ConnectQualityPolicy {
  /** Maximum records returned by one tool call across pages. */
  readonly maxRecords?: number;
  /** Maximum exact pages read by one tool call. */
  readonly maxPages?: number;
  /** Maximum serialized result bytes exposed to model. */
  readonly maxResultBytes?: number;
  /** Default refuses completeness-dependent answers after any cap is reached. */
  readonly incomplete?: "refuse";
}

export interface ConnectOptions extends ConnectRuntimeOptions {
  readonly sources: readonly ConnectSource[];
  readonly quality?: ConnectQualityPolicy;
  readonly toolName?: string;
}

export interface NormalizedConnectQualityPolicy {
  readonly maxRecords: number;
  readonly maxPages: number;
  readonly maxResultBytes: number;
  readonly incomplete: "refuse";
}

export interface NormalizedConnectSource {
  readonly id: string;
  readonly provider: string;
  readonly connectionId?: string;
  readonly collect: readonly string[];
  readonly models: readonly string[];
  readonly actions: readonly NormalizedConnectAction[];
}

/** Serializable runtime marker. Contains source allowlists, never credentials. */
export interface ConnectToolRuntimeDefinition {
  readonly kind: "caveman-connect";
  readonly sources: readonly NormalizedConnectSource[];
  readonly quality: NormalizedConnectQualityPolicy;
  readonly binary?: string;
  readonly timeoutMs: number;
  readonly maxCaptureBytes: number;
}

export interface ConnectIntegration {
  readonly tool: ToolDefinition;
  readonly sources: readonly NormalizedConnectSource[];
  readonly quality: NormalizedConnectQualityPolicy;
  /** Open provider authorization. Credentials remain owned by cave-connectd. */
  connect(sourceId: string, onOutput?: ConnectExecuteOptions["onOutput"]): Promise<void>;
  /** Trigger every configured sync once. Returns exact daemon acknowledgements. */
  collect(sourceId?: string, signal?: AbortSignal): Promise<readonly unknown[]>;
  /** Read saved connections without credential material. */
  connections(signal?: AbortSignal): Promise<readonly ConnectConnection[]>;
}

export interface ConnectEfficiencyRun {
  readonly taskSuccess: boolean;
  /** Same grader and scale required for baseline and connected run. */
  readonly quality: number;
  /** Provider/model spend only when complete; otherwise null. */
  readonly providerCostUsd: number | null;
  readonly providerInputTokens: number | null;
  readonly providerOutputTokens: number | null;
  readonly retries: number;
  readonly retrievalCalls: number;
  readonly retrievalCostUsd: number | null;
  readonly collectionCostUsd: number | null;
  readonly completeData: boolean;
}

export interface ConnectEfficiencyComparison {
  readonly evidence: "inferred";
  readonly accepted: boolean;
  readonly reasons: readonly string[];
  readonly baselineTotalCostUsd: number | null;
  readonly connectedTotalCostUsd: number | null;
  readonly costDeltaUsd: number | null;
  readonly inputTokenDelta: number | null;
  readonly retryDelta: number;
  readonly qualityDelta: number;
}

export function connectEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of CONNECT_ENV_ALLOWLIST) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

function positiveInteger(value: number | undefined, fallback: number, code: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw new Error(code);
  return resolved;
}

function safeIdentifier(value: string, code: string): string {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value)) throw new Error(code);
  return value;
}

function safeExternalIdentifier(value: string, code: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(value)) throw new Error(code);
  return value;
}

function uniqueNames(values: readonly string[] | undefined, code: string): readonly string[] {
  const normalized = Object.freeze([...(values ?? [])].map((value) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) throw new Error(code);
    return value;
  }));
  if (new Set(normalized).size !== normalized.length) throw new Error(`${code}_duplicate`);
  return normalized;
}

function uniqueExternalIdentifiers(
  values: readonly string[] | undefined,
  code: string,
): readonly string[] {
  const normalized = Object.freeze(
    [...(values ?? [])].map((value) => safeExternalIdentifier(value, code)),
  );
  if (new Set(normalized).size !== normalized.length) throw new Error(`${code}_duplicate`);
  return normalized;
}

function normalizeActions(
  values: readonly (string | ConnectAction)[] | undefined,
): readonly NormalizedConnectAction[] {
  const names = new Set<string>();
  return Object.freeze([...(values ?? [])].map((value) => {
    const entry = typeof value === "string"
      ? { name: value, bind: undefined }
      : snapshotDataRecord(value, ["name", "bind"], ["name"], () => {
        throw new Error("cave_connect_action_invalid");
      });
    const name = safeExternalIdentifier(
      typeof entry.name === "string" ? entry.name : "",
      "cave_connect_action_invalid",
    );
    if (names.has(name)) throw new Error("cave_connect_action_invalid_duplicate");
    names.add(name);
    if (entry.bind === undefined) return Object.freeze({ name, bind: Object.freeze({}) });
    const bind = snapshotDataDictionary(entry.bind, CONNECT_ACTION_BIND_MAX_KEYS, () => {
      throw new Error("cave_connect_action_bind_invalid");
    });
    for (const key of Object.keys(bind)) {
      const bound = bind[key];
      const serializable = bound === null || typeof bound === "string" ||
        typeof bound === "boolean" || (typeof bound === "number" && Number.isFinite(bound));
      if (!serializable) throw new Error(`cave_connect_action_bind_invalid:${key}`);
    }
    return Object.freeze({ name, bind: Object.freeze(bind) as NormalizedConnectAction["bind"] });
  }));
}

function normalizeSources(sources: readonly ConnectSource[]): readonly NormalizedConnectSource[] {
  if (sources.length === 0) throw new Error("cave_connect_sources_required");
  const ids = new Set<string>();
  return Object.freeze(sources.map((source) => {
    const id = safeIdentifier(source.id, "cave_connect_source_id_invalid");
    if (ids.has(id)) throw new Error(`cave_connect_source_duplicate:${id}`);
    ids.add(id);
    const provider = safeIdentifier(source.provider, "cave_connect_provider_invalid");
    const connectionId = source.connectionId === undefined
      ? undefined
      : safeExternalIdentifier(source.connectionId, "cave_connect_connection_id_invalid");
    return Object.freeze({
      id,
      provider,
      ...(connectionId === undefined ? {} : { connectionId }),
      collect: uniqueExternalIdentifiers(source.collect, "cave_connect_sync_invalid"),
      models: uniqueNames(source.models, "cave_connect_model_invalid"),
      actions: normalizeActions(source.actions),
    });
  }));
}

function normalizeQuality(value: ConnectQualityPolicy | undefined): NormalizedConnectQualityPolicy {
  if (value?.incomplete !== undefined && value.incomplete !== "refuse") {
    throw new Error("cave_connect_incomplete_policy_invalid");
  }
  const maxResultBytes = positiveInteger(
    value?.maxResultBytes,
    DEFAULT_RESULT_BYTES,
    "cave_connect_max_result_bytes_invalid",
  );
  if (maxResultBytes > 30 * 1024) throw new Error("cave_connect_max_result_bytes_too_large");
  return Object.freeze({
    maxRecords: positiveInteger(value?.maxRecords, 100, "cave_connect_max_records_invalid"),
    maxPages: positiveInteger(value?.maxPages, 5, "cave_connect_max_pages_invalid"),
    maxResultBytes,
    incomplete: "refuse",
  });
}

async function validateBinary(path: string): Promise<string> {
  const resolved = await realpath(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`cave_connect_binary_missing:${path}`);
    }
    throw error;
  });
  const info = await lstat(resolved);
  if (!info.isFile()) throw new Error(`cave_connect_binary_invalid:${path}`);
  await access(resolved, constants.X_OK).catch(() => {
    throw new Error(`cave_connect_binary_not_executable:${path}`);
  });
  return resolved;
}

export async function resolveConnectBinary(
  options: Pick<ConnectRuntimeOptions, "binary" | "environment"> = {},
): Promise<string> {
  const environment = options.environment ?? process.env;
  const override = options.binary ?? environment.CAVE_CONNECT_BIN;
  if (override !== undefined) {
    if (!isAbsolute(override)) throw new Error("cave_connect_binary_override_not_absolute");
    return validateBinary(override);
  }
  const pathValue = environment.PATH ?? "";
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    for (const name of ["cave-connectd", "cave-connect"]) {
      try {
        return await validateBinary(join(directory, name));
      } catch {
        // Any unusable candidate is simply "not this one": a directory, a
        // non-executable file, or an ENOTDIR PATH entry must not stop the
        // scan before a valid binary further along PATH.
      }
    }
  }
  throw new Error("cave_connect_binary_missing: set CAVE_CONNECT_BIN to cave-connectd");
}

async function executeConnectProcess(
  binary: string,
  args: readonly string[],
  options: ConnectExecuteOptions,
): Promise<ConnectProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [...args], {
      env: { ...options.environment },
      stdio: options.capture ? ["pipe", "pipe", "pipe"] : ["inherit", "inherit", "inherit"],
    });
    // A daemon that dies before draining stdin makes end() emit EPIPE on an
    // unhandled stream; that would surface as an uncaught host exception.
    child.stdin?.on("error", () => undefined);
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      callback();
    };
    const abort = (): void => {
      child.kill("SIGKILL");
      finish(() => reject(options.signal?.reason instanceof Error
        ? options.signal.reason
        : new Error("cave_connect_process_aborted")));
    };
    // A wall-clock kill is right for a non-interactive request. An inherited
    // stdio invocation is a human-in-the-loop authorization flow, and killing
    // it after `timeoutMs` aborts the browser/device-code step mid-way.
    const timer = options.capture
      ? setTimeout(() => {
        child.kill("SIGKILL");
        finish(() => reject(new Error("cave_connect_process_timeout")));
      }, options.timeoutMs)
      : undefined;
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) {
      abort();
      return;
    }
    child.once("error", (error) => finish(() => reject(error)));
    if (!options.capture) {
      child.once("exit", (code, signal) => finish(() => {
        if (signal !== null) reject(new Error(`cave_connect_process_signal:${signal}`));
        else resolve({ exitCode: code ?? 1, stdout: "", stderr: "" });
      }));
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let captured = 0;
    let overflow = false;
    const append = (
      target: Buffer[],
      decoder: StringDecoder,
      stream: "stdout" | "stderr",
      value: Buffer,
    ): void => {
      if (overflow) return;
      captured += value.byteLength;
      if (captured > options.maxCaptureBytes) {
        overflow = true;
        child.kill("SIGKILL");
        return;
      }
      target.push(value);
      const decoded = decoder.write(value);
      if (decoded !== "") options.onOutput?.(decoded, stream);
    };
    child.stdout?.on("data", (value: Buffer) => append(stdout, stdoutDecoder, "stdout", value));
    child.stderr?.on("data", (value: Buffer) => append(stderr, stderrDecoder, "stderr", value));
    child.once("close", (code, signal) => finish(() => {
      const stdoutTail = stdoutDecoder.end();
      const stderrTail = stderrDecoder.end();
      if (stdoutTail !== "") options.onOutput?.(stdoutTail, "stdout");
      if (stderrTail !== "") options.onOutput?.(stderrTail, "stderr");
      if (overflow) reject(new Error("cave_connect_process_output_too_large"));
      else if (signal !== null) reject(new Error(`cave_connect_process_signal:${signal}`));
      else resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    }));
    child.stdin?.end(options.input ?? "", "utf8");
  });
}

function parsedObject(value: string, code: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error(code);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(code);
  return parsed as Record<string, unknown>;
}

function processFailure(result: ConnectProcessResult): Error {
  const detail = (result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`)
    .replace(/[\r\n]+/g, " ")
    .slice(0, 2_048);
  return new Error(`cave_connect_process_failed:${detail}`);
}

function mcpResponse(stdout: string, id: number): Record<string, unknown> {
  let match: Record<string, unknown> | undefined;
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    const frame = parsedObject(line, "cave_connect_mcp_frame_invalid");
    if (frame.id === id) {
      if (match !== undefined) throw new Error(`cave_connect_mcp_response_duplicate:${id}`);
      match = frame;
    }
  }
  if (match === undefined) throw new Error(`cave_connect_mcp_response_missing:${id}`);
  return match;
}

function mcpError(frame: Record<string, unknown>): Error | undefined {
  if (frame.error === undefined) return undefined;
  if (frame.error === null || typeof frame.error !== "object" || Array.isArray(frame.error)) {
    return new Error("cave_connect_mcp_error:malformed error");
  }
  const message = (frame.error as Record<string, unknown>).message;
  return new Error(`cave_connect_mcp_error:${typeof message === "string" ? message : "unknown"}`);
}

type ConnectMcpJSON = null | boolean | number | string |
  readonly ConnectMcpJSON[] | ConnectMcpJSONObject;

interface ConnectMcpJSONObject {
  readonly [key: string]: ConnectMcpJSON;
}

interface ConnectMcpJSONState {
  nodes: number;
  readonly active: Set<object>;
}

interface ConnectMcpToolPage {
  readonly tools: readonly ConnectMcpTool[];
  readonly nextCursor?: string;
}

function toolListInvalid(): never {
  throw new Error("cave_connect_mcp_tool_list_invalid");
}

function copyMcpJSON(
  value: unknown,
  state: ConnectMcpJSONState,
  depth = 0,
): ConnectMcpJSON {
  state.nodes++;
  if (state.nodes > CONNECT_TOOL_LIST_MAX_JSON_NODES ||
      depth > CONNECT_TOOL_LIST_MAX_JSON_DEPTH) {
    throw new Error("cave_connect_mcp_tool_list_json_limit");
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) toolListInvalid();
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") toolListInvalid();
  if (state.active.has(value)) toolListInvalid();
  state.active.add(value);
  try {
    if (Array.isArray(value)) {
      const source = snapshotDenseArray(
        value,
        CONNECT_TOOL_LIST_MAX_JSON_NODES,
        toolListInvalid,
      );
      return Object.freeze(source.map((item) => copyMcpJSON(item, state, depth + 1)));
    }
    const source = snapshotDataDictionary(
      value,
      CONNECT_TOOL_LIST_MAX_JSON_NODES,
      toolListInvalid,
    );
    const copy: Record<string, ConnectMcpJSON> = Object.create(null) as Record<string, ConnectMcpJSON>;
    for (const key of Object.keys(source).sort()) {
      copy[key] = copyMcpJSON(source[key], state, depth + 1);
    }
    return Object.freeze(copy);
  } finally {
    state.active.delete(value);
  }
}

function copyMcpJSONObject(
  value: unknown,
  state: ConnectMcpJSONState,
): Readonly<Record<string, ConnectMcpJSON>> {
  const copy = copyMcpJSON(value, state);
  if (copy === null || Array.isArray(copy) || typeof copy !== "object") toolListInvalid();
  return copy as ConnectMcpJSONObject;
}

function optionalString(
  source: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  if (!Object.hasOwn(source, key)) return undefined;
  const value = source[key];
  if (typeof value !== "string") toolListInvalid();
  return value;
}

function optionalBoolean(
  source: Readonly<Record<string, unknown>>,
  key: string,
): boolean | undefined {
  if (!Object.hasOwn(source, key)) return undefined;
  const value = source[key];
  if (typeof value !== "boolean") toolListInvalid();
  return value;
}

function copyMcpSchema(
  value: unknown,
  state: ConnectMcpJSONState,
): Readonly<Record<string, unknown>> {
  const schemaValue = copyMcpJSONObject(value, state);
  if (schemaValue["type"] !== "object") toolListInvalid();
  return schemaValue;
}

function copyMcpAnnotations(value: unknown): ConnectMcpToolAnnotations {
  const source = snapshotDataRecord(
    value,
    ["title", "readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"],
    [],
    toolListInvalid,
  );
  const title = optionalString(source, "title");
  const readOnlyHint = optionalBoolean(source, "readOnlyHint");
  const destructiveHint = optionalBoolean(source, "destructiveHint");
  const idempotentHint = optionalBoolean(source, "idempotentHint");
  const openWorldHint = optionalBoolean(source, "openWorldHint");
  return Object.freeze({
    ...(title === undefined ? {} : { title }),
    ...(readOnlyHint === undefined ? {} : { readOnlyHint }),
    ...(destructiveHint === undefined ? {} : { destructiveHint }),
    ...(idempotentHint === undefined ? {} : { idempotentHint }),
    ...(openWorldHint === undefined ? {} : { openWorldHint }),
  });
}

function copyMcpExecution(value: unknown): ConnectMcpToolExecution {
  const source = snapshotDataRecord(value, ["taskSupport"], [], toolListInvalid);
  const taskSupport = optionalString(source, "taskSupport");
  if (taskSupport !== undefined &&
      taskSupport !== "forbidden" && taskSupport !== "optional" && taskSupport !== "required") {
    toolListInvalid();
  }
  return Object.freeze(taskSupport === undefined ? {} : { taskSupport });
}

function copyMcpIcon(value: unknown): ConnectMcpToolIcon {
  const source = snapshotDataRecord(
    value,
    ["src", "mimeType", "sizes", "theme"],
    ["src"],
    toolListInvalid,
  );
  const src = source["src"];
  if (typeof src !== "string") toolListInvalid();
  const mimeType = optionalString(source, "mimeType");
  const theme = optionalString(source, "theme");
  if (theme !== undefined && theme !== "light" && theme !== "dark") toolListInvalid();
  let sizes: readonly string[] | undefined;
  if (Object.hasOwn(source, "sizes")) {
    const rawSizes = snapshotDenseArray(
      source["sizes"],
      CONNECT_TOOL_LIST_MAX_JSON_NODES,
      toolListInvalid,
    );
    if (rawSizes.some((size) => typeof size !== "string")) toolListInvalid();
    sizes = Object.freeze(rawSizes as string[]);
  }
  return Object.freeze({
    src,
    ...(mimeType === undefined ? {} : { mimeType }),
    ...(sizes === undefined ? {} : { sizes }),
    ...(theme === undefined ? {} : { theme }),
  });
}

function copyMcpTool(value: unknown, state: ConnectMcpJSONState): ConnectMcpTool {
  const source = snapshotDataRecord(
    value,
    [
      "name",
      "title",
      "description",
      "inputSchema",
      "outputSchema",
      "annotations",
      "execution",
      "icons",
      "_meta",
    ],
    ["name", "inputSchema"],
    toolListInvalid,
  );
  const name = source["name"];
  if (typeof name !== "string" || !/^[A-Za-z][A-Za-z0-9_.:-]{0,254}$/.test(name)) {
    toolListInvalid();
  }
  const title = optionalString(source, "title");
  const description = optionalString(source, "description");
  const inputSchema = copyMcpSchema(source["inputSchema"], state);
  const outputSchema = Object.hasOwn(source, "outputSchema")
    ? copyMcpSchema(source["outputSchema"], state)
    : undefined;
  const annotations = Object.hasOwn(source, "annotations")
    ? copyMcpAnnotations(source["annotations"])
    : undefined;
  const execution = Object.hasOwn(source, "execution")
    ? copyMcpExecution(source["execution"])
    : undefined;
  let icons: readonly ConnectMcpToolIcon[] | undefined;
  if (Object.hasOwn(source, "icons")) {
    const rawIcons = snapshotDenseArray(
      source["icons"],
      CONNECT_TOOL_LIST_MAX_JSON_NODES,
      toolListInvalid,
    );
    icons = Object.freeze(rawIcons.map(copyMcpIcon));
  }
  const metadata = Object.hasOwn(source, "_meta")
    ? copyMcpJSONObject(source["_meta"], state)
    : undefined;
  return Object.freeze({
    name,
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    inputSchema,
    ...(outputSchema === undefined ? {} : { outputSchema }),
    ...(annotations === undefined ? {} : { annotations }),
    ...(execution === undefined ? {} : { execution }),
    ...(icons === undefined ? {} : { icons }),
    ...(metadata === undefined ? {} : { _meta: metadata }),
  });
}

function parseMcpToolPage(
  frame: Record<string, unknown>,
  state: ConnectMcpJSONState,
): ConnectMcpToolPage {
  const response = snapshotDataRecord(
    frame,
    ["jsonrpc", "id", "result", "error"],
    ["jsonrpc", "id"],
    toolListInvalid,
  );
  if (response["jsonrpc"] !== "2.0" || response["id"] !== 2) toolListInvalid();
  const hasResult = Object.hasOwn(response, "result");
  const hasError = Object.hasOwn(response, "error");
  if (hasResult === hasError) toolListInvalid();
  if (hasError) throw mcpError(response) ?? new Error("cave_connect_mcp_error:unknown");
  const result = snapshotDataRecord(
    response["result"],
    ["tools", "nextCursor", "_meta"],
    ["tools"],
    toolListInvalid,
  );
  if (Object.hasOwn(result, "_meta")) copyMcpJSONObject(result["_meta"], state);
  const rawTools = snapshotDenseArray(
    result["tools"],
    CONNECT_TOOL_LIST_MAX_JSON_NODES,
    toolListInvalid,
  );
  if (rawTools.length > CONNECT_TOOL_LIST_MAX_TOOLS) {
    throw new Error("cave_connect_mcp_tool_list_count_limit");
  }
  const tools = Object.freeze(rawTools.map((toolValue) => copyMcpTool(toolValue, state)));
  let nextCursor: string | undefined;
  if (Object.hasOwn(result, "nextCursor")) {
    const candidate = result["nextCursor"];
    if (typeof candidate !== "string" || candidate.length === 0 ||
        Buffer.byteLength(candidate, "utf8") > CONNECT_TOOL_LIST_MAX_CURSOR_BYTES) {
      throw new Error("cave_connect_mcp_tool_list_cursor_invalid");
    }
    nextCursor = candidate;
  }
  return Object.freeze({ tools, ...(nextCursor === undefined ? {} : { nextCursor }) });
}

export class ConnectRuntime {
  readonly #options: ConnectRuntimeOptions;
  readonly #execute: ConnectExecutor;
  readonly #timeoutMs: number;
  readonly #maxCaptureBytes: number;
  #binaryPromise: Promise<string> | undefined;

  constructor(options: ConnectRuntimeOptions = {}) {
    this.#options = options;
    this.#execute = options.execute ?? executeConnectProcess;
    this.#timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, "cave_connect_timeout_invalid");
    this.#maxCaptureBytes = positiveInteger(
      options.maxCaptureBytes,
      DEFAULT_CAPTURE_BYTES,
      "cave_connect_capture_limit_invalid",
    );
  }

  async delegate(args: readonly string[], signal?: AbortSignal): Promise<number> {
    const mapped = args.length === 0
      ? ["open"]
      : CONNECT_COMMANDS.has(args[0] ?? "") || (args[0]?.startsWith("-") ?? false)
        ? [...args]
        : ["connect", ...args];
    const result = await this.#run(mapped, false, signal);
    return result.exitCode;
  }

  async connect(
    provider: string,
    onOutput?: ConnectExecuteOptions["onOutput"],
    signal?: AbortSignal,
  ): Promise<void> {
    safeIdentifier(provider, "cave_connect_provider_invalid");
    const result = await this.#run(["connect", provider], true, signal, undefined, onOutput);
    if (result.exitCode !== 0) throw processFailure(result);
  }

  async call(toolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ConnectMcpCallResult> {
    if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,254}$/.test(toolName)) {
      throw new Error("cave_connect_tool_invalid");
    }
    const frame = await this.#mcpRequest("tools/call", { name: toolName, arguments: args }, signal);
    const error = mcpError(frame);
    if (error !== undefined) throw error;
    const result = frame.result;
    if (result === null || typeof result !== "object" || Array.isArray(result)) {
      throw new Error("cave_connect_mcp_call_invalid");
    }
    const payload = result as Record<string, unknown>;
    return Object.freeze({
      isError: payload.isError === true,
      structuredContent: payload.structuredContent ?? null,
      content: Array.isArray(payload.content) ? payload.content : [],
    });
  }

  /** Lists detached connection metadata. Credential fields are never projected. */
  async connections(signal?: AbortSignal): Promise<readonly ConnectConnection[]> {
    return connectionRows(structured(
      await this.call("caveman_connection_list", {}, signal),
    ));
  }

  /**
   * Lists every MCP tool through exact cursor pagination. Discovery is bounded
   * and returns only detached, deeply frozen plain data.
   */
  async listTools(signal?: AbortSignal): Promise<readonly ConnectMcpTool[]> {
    const tools: ConnectMcpTool[] = [];
    const names = new Set<string>();
    const cursors = new Set<string>();
    const jsonState: ConnectMcpJSONState = { nodes: 0, active: new Set() };
    let resultBytes = 2;
    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < CONNECT_TOOL_LIST_MAX_PAGES; pageIndex++) {
      const frame = await this.#mcpRequest(
        "tools/list",
        cursor === undefined ? {} : { cursor },
        signal,
      );
      const page = parseMcpToolPage(frame, jsonState);
      for (const descriptor of page.tools) {
        if (names.has(descriptor.name)) {
          throw new Error(`cave_connect_mcp_tool_list_duplicate:${descriptor.name}`);
        }
        if (tools.length >= CONNECT_TOOL_LIST_MAX_TOOLS) {
          throw new Error("cave_connect_mcp_tool_list_count_limit");
        }
        const encoded = JSON.stringify(descriptor);
        resultBytes += Buffer.byteLength(encoded, "utf8") + (tools.length === 0 ? 0 : 1);
        if (resultBytes > CONNECT_TOOL_LIST_MAX_BYTES) {
          throw new Error("cave_connect_mcp_tool_list_byte_limit");
        }
        names.add(descriptor.name);
        tools.push(descriptor);
      }
      if (page.nextCursor === undefined) return Object.freeze(tools);
      if (cursors.has(page.nextCursor)) {
        throw new Error("cave_connect_mcp_tool_list_cursor_cycle");
      }
      cursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    throw new Error("cave_connect_mcp_tool_list_page_limit");
  }

  async #mcpRequest(
    method: "tools/call" | "tools/list",
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const bootstrap = await this.#run(
      ["providers", CONNECT_BOOTSTRAP_QUERY, "--limit", "1", "--json"],
      true,
      signal,
    );
    if (bootstrap.exitCode !== 0) throw processFailure(bootstrap);
    const id = 2;
    const input = [
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "@caveman-ai/agent", version: FRAMEWORK_VERSION },
        },
      }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
      JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      "",
    ].join("\n");
    if (Buffer.byteLength(input, "utf8") > this.#maxCaptureBytes) {
      throw new Error("cave_connect_mcp_request_too_large");
    }
    const result = await this.#run(["mcp"], true, signal, input);
    if (result.exitCode !== 0) throw processFailure(result);
    return mcpResponse(result.stdout, id);
  }

  async #run(
    args: readonly string[],
    capture: boolean,
    signal?: AbortSignal,
    input?: string,
    onOutput?: ConnectExecuteOptions["onOutput"],
  ): Promise<ConnectProcessResult> {
    const binary = await (this.#binaryPromise ??= resolveConnectBinary(this.#options));
    return this.#execute(binary, args, {
      environment: connectEnvironment(this.#options.environment ?? process.env),
      capture,
      timeoutMs: this.#timeoutMs,
      maxCaptureBytes: this.#maxCaptureBytes,
      ...(signal === undefined ? {} : { signal }),
      ...(input === undefined ? {} : { input }),
      ...(onOutput === undefined ? {} : { onOutput }),
    });
  }
}

function actionLabel(action: NormalizedConnectAction): string {
  const fixed = Object.keys(action.bind);
  return fixed.length === 0 ? action.name : `${action.name}(fixed:${fixed.join("+")})`;
}

function connectToolDescription(sources: readonly NormalizedConnectSource[]): string {
  const manifest = sources.map((source) => [
    `${source.id}=${source.provider}`,
    source.collect.length === 0 ? "existing-records-only" : `syncs:${source.collect.join(",")}`,
    source.models.length === 0 ? "models:any-connected" : `models:${source.models.join(",")}`,
    source.actions.length === 0 ? "actions:none" : `actions:${source.actions.map(actionLabel).join(",")}`,
  ].join(" ")).join("; ");
  return [
    "Access explicitly allowed Caveman Connect sources through one bounded tool.",
    "Use sources first, search_syncs before collect, then records for exact synced data.",
    "Never claim a complete answer when result.complete is false or must_refuse is true; continue with next_cursor or say what remains unread.",
    "Provider actions execute only when allowlisted in source config; arguments marked fixed are set by config and must be omitted.",
    `Sources: ${manifest}.`,
  ].join(" ");
}

const CONNECT_TOOL_INPUT = schema.object({
  operation: schema.union([
    schema.literal("sources"),
    schema.literal("connections"),
    schema.literal("search_syncs"),
    schema.literal("collect"),
    schema.literal("sync_status"),
    schema.literal("records"),
    schema.literal("search_actions"),
    schema.literal("call_action"),
  ]),
  source: schema.optional(schema.string()),
  query: schema.optional(schema.string()),
  sync: schema.optional(schema.string()),
  run_id: schema.optional(schema.string()),
  model: schema.optional(schema.string()),
  cursor: schema.optional(schema.string()),
  limit: schema.optional(schema.integer()),
  offset: schema.optional(schema.integer()),
  action: schema.optional(schema.string()),
  input: schema.optional(schema.any()),
});

function runtimeOptions(runtime: ConnectToolRuntimeDefinition): ConnectRuntimeOptions {
  return {
    ...(runtime.binary === undefined ? {} : { binary: runtime.binary }),
    timeoutMs: runtime.timeoutMs,
    maxCaptureBytes: runtime.maxCaptureBytes,
  };
}

function sourceById(
  runtime: ConnectToolRuntimeDefinition,
  sourceId: unknown,
): NormalizedConnectSource {
  if (typeof sourceId !== "string" || sourceId === "") throw new Error("cave_connect_source_required");
  const source = runtime.sources.find((candidate) => candidate.id === sourceId);
  if (source === undefined) throw new Error(`cave_connect_source_not_allowed:${sourceId}`);
  return source;
}

function structured(result: ConnectMcpCallResult): unknown {
  if (result.isError) throw new Error("cave_connect_tool_failed");
  return result.structuredContent;
}

function asRecord(value: unknown, code: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function connectionRows(value: unknown): readonly ConnectConnection[] {
  const object = asRecord(value, "cave_connect_connections_invalid");
  const rows = Array.isArray(object.data)
    ? object.data
    : Array.isArray(object.connections)
      ? object.connections
      : undefined;
  if (rows === undefined) throw new Error("cave_connect_connections_invalid");
  return Object.freeze(rows.map((row) => {
    const record = asRecord(row, "cave_connect_connection_invalid");
    const connectionId = record.connection_id;
    const provider = record.provider_config_key;
    if (typeof connectionId !== "string" || connectionId === "" ||
        typeof provider !== "string" || provider === "") {
      throw new Error("cave_connect_connection_invalid");
    }
    return Object.freeze({
      connectionId,
      provider,
      authMode: typeof record.auth_mode === "string" ? record.auth_mode : "unknown",
      status: typeof record.status === "string" ? record.status : "unknown",
    });
  }));
}

async function resolveConnectionId(
  client: ConnectRuntime,
  source: NormalizedConnectSource,
  signal?: AbortSignal,
): Promise<string> {
  if (source.connectionId !== undefined) return source.connectionId;
  const rows = (await client.connections(signal))
    .filter((row) => row.provider === source.provider && row.status !== "disconnected");
  if (rows.length !== 1) {
    throw new Error(`cave_connect_connection_ambiguous:${source.id}:${rows.length}`);
  }
  return rows[0]!.connectionId;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`cave_connect_${field}_required`);
  return value;
}

function actionByName(source: NormalizedConnectSource, name: string): NormalizedConnectAction {
  const action = source.actions.find((candidate) => candidate.name === name);
  if (action === undefined) throw new Error(`cave_connect_action_not_allowed:${name}`);
  return action;
}

/**
 * Merge model-chosen arguments under the values trusted config fixed. Bound
 * keys are rejected rather than silently overridden, so a model attempting to
 * redirect an action fails instead of appearing to succeed elsewhere.
 */
function boundActionInput(
  action: NormalizedConnectAction,
  value: unknown,
): Record<string, unknown> {
  if (value !== undefined && (value === null || typeof value !== "object" || Array.isArray(value))) {
    throw new Error("cave_connect_action_input_invalid");
  }
  const supplied = (value ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(action.bind)) {
    if (Object.hasOwn(supplied, key)) throw new Error(`cave_connect_action_bind_conflict:${key}`);
  }
  return { ...supplied, ...action.bind };
}

/** Key-order-independent serialization so a retry of one call hashes equally. */
function stableJson(value: unknown, depth: number): string {
  if (depth > CONNECT_ACTION_INPUT_MAX_DEPTH) throw new Error("cave_connect_action_input_invalid");
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("cave_connect_action_input_invalid");
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item, depth + 1)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(record[key], depth + 1)}`).join(",")}}`;
}

function actionIdempotencyKey(
  source: NormalizedConnectSource,
  action: NormalizedConnectAction,
  payload: Record<string, unknown>,
): string {
  return createHash("sha256")
    .update(stableJson([source.id, source.provider, action.name, payload], 0))
    .digest("hex");
}

/**
 * Actions this process fired without learning whether they ran. A timeout, an
 * abort, or a result that exceeded the byte cap all leave the side effect
 * possibly applied, so an identical repeat is refused rather than fired twice.
 *
 * ponytail: process-scoped Set, cap 256 with oldest-first eviction. Move to a
 * durable store if actions must stay guarded across restarts.
 */
const actionOutcomeUnknown = new Set<string>();

function rememberUnknownOutcome(key: string): void {
  actionOutcomeUnknown.delete(key);
  actionOutcomeUnknown.add(key);
  if (actionOutcomeUnknown.size > CONNECT_ACTION_UNKNOWN_OUTCOME_MAX) {
    for (const oldest of actionOutcomeUnknown) {
      actionOutcomeUnknown.delete(oldest);
      break;
    }
  }
}

function assertAllowed(value: string, allowed: readonly string[], code: string): void {
  if (!allowed.includes(value)) throw new Error(`${code}:${value}`);
}

function boundedLimit(value: unknown, fallback: number, maximum: number): number {
  const limit = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > maximum) {
    throw new Error("cave_connect_limit_invalid");
  }
  return Number(limit);
}

function boundedOffset(value: unknown): number {
  const offset = value ?? 0;
  if (!Number.isSafeInteger(offset) || Number(offset) < 0 || Number(offset) > 10_000) {
    throw new Error("cave_connect_offset_invalid");
  }
  return Number(offset);
}

function resultBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function boundedResult(
  value: unknown,
  quality: NormalizedConnectQualityPolicy,
  recovery: string,
): unknown {
  if (resultBytes(value) > quality.maxResultBytes) {
    throw new Error(`cave_connect_result_too_large:${recovery}`);
  }
  return value;
}

async function readRecords(
  client: ConnectRuntime,
  source: NormalizedConnectSource,
  connectionId: string,
  model: string,
  initialCursor: string | undefined,
  requestedLimit: number,
  quality: NormalizedConnectQualityPolicy,
  signal?: AbortSignal,
): Promise<unknown> {
  const records: unknown[] = [];
  let cursor = initialCursor;
  let pages = 0;
  let cappedBy: "records" | "pages" | "bytes" | undefined;
  while (pages < quality.maxPages && records.length < Math.min(quality.maxRecords, requestedLimit)) {
    const remaining = Math.min(100, requestedLimit - records.length, quality.maxRecords - records.length);
    const pageRequestCursor = cursor;
    const payload = structured(await client.call("caveman_records_list", {
      provider: source.provider,
      connection_id: connectionId,
      model,
      limit: remaining,
      ...(cursor === undefined ? {} : { cursor }),
    }, signal));
    const page = asRecord(payload, "cave_connect_records_invalid");
    const pageRecords = Array.isArray(page.records)
      ? page.records
      : Array.isArray((page.data as Record<string, unknown> | undefined)?.records)
        ? (page.data as Record<string, unknown>).records as unknown[]
        : undefined;
    if (pageRecords === undefined) throw new Error("cave_connect_records_invalid");
    // Unknown pagination state fails closed: an unreadable cursor is not
    // evidence that the page was the last one.
    const rawNextCursor = page.next_cursor ??
      (page.data as Record<string, unknown> | undefined)?.next_cursor;
    if (rawNextCursor !== undefined && rawNextCursor !== null &&
        typeof rawNextCursor !== "string") {
      throw new Error("cave_connect_records_invalid");
    }
    const nextCursorValue = typeof rawNextCursor === "string" ? rawNextCursor : undefined;
    const candidate = [...records, ...pageRecords];
    const envelope = { records: candidate, next_cursor: nextCursorValue ?? null };
    if (resultBytes(envelope) > quality.maxResultBytes) {
      // Never return a cursor past records omitted from this page. Caller can
      // retry same cursor with smaller limit; no hidden gap is introduced.
      cappedBy = "bytes";
      cursor = pageRequestCursor;
      break;
    }
    records.push(...pageRecords);
    pages += 1;
    cursor = nextCursorValue;
    if (cappedBy !== undefined || cursor === undefined || cursor === "") break;
  }
  if (cappedBy === undefined && cursor !== undefined && cursor !== "") {
    cappedBy = records.length >= Math.min(quality.maxRecords, requestedLimit) ? "records" : "pages";
  }
  const complete = cappedBy === undefined && (cursor === undefined || cursor === "");
  return Object.freeze({
    source: source.id,
    provider: source.provider,
    model,
    records,
    pages,
    complete,
    next_cursor: complete ? null : cursor ?? initialCursor ?? null,
    capped_by: cappedBy ?? null,
    must_refuse: !complete,
    evidence: "source_records",
  });
}

/** Kernel-owned execution for `ConnectToolRuntimeDefinition`; never runs arbitrary host closure. */
export async function executeConnectTool(
  runtime: ConnectToolRuntimeDefinition,
  params: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const input = asRecord(params, "cave_connect_arguments_invalid");
  const operation = requiredString(input.operation, "operation");
  if (operation === "sources") {
    return boundedResult({
      sources: runtime.sources.map((source) => ({
        id: source.id,
        provider: source.provider,
        collect: source.collect,
        models: source.models,
        actions: source.actions.map(actionLabel),
      })),
      quality: runtime.quality,
    }, runtime.quality, "configure fewer sources");
  }
  const client = new ConnectRuntime(runtimeOptions(runtime));
  if (operation === "connections") {
    return boundedResult(
      structured(await client.call("caveman_connection_list", {}, signal)),
      runtime.quality,
      "configure exact connectionId values",
    );
  }
  const source = sourceById(runtime, input.source);
  if (operation === "search_syncs") {
    return boundedResult(structured(await client.call("caveman_sync_search", {
      provider: source.provider,
      query: typeof input.query === "string" ? input.query : "",
      limit: boundedLimit(input.limit, 20, 50),
      offset: boundedOffset(input.offset),
    }, signal)), runtime.quality, "use narrower query, lower limit, or next offset");
  }
  if (operation === "search_actions") {
    return boundedResult(structured(await client.call("caveman_tool_search", {
      provider: source.provider,
      query: typeof input.query === "string" ? input.query : "",
      limit: boundedLimit(input.limit, 20, 50),
      offset: boundedOffset(input.offset),
    }, signal)), runtime.quality, "use narrower query, lower limit, or next offset");
  }
  const connectionId = await resolveConnectionId(client, source, signal);
  if (operation === "collect") {
    const sync = requiredString(input.sync, "sync");
    assertAllowed(sync, source.collect, "cave_connect_sync_not_allowed");
    return boundedResult(structured(await client.call("caveman_sync_trigger", {
      provider: source.provider,
      connection_id: connectionId,
      sync,
    }, signal)), runtime.quality, "inspect sync status by run id");
  }
  if (operation === "sync_status") {
    return boundedResult(structured(await client.call("caveman_sync_status", {
      provider: source.provider,
      connection_id: connectionId,
      run_id: requiredString(input.run_id, "run_id"),
    }, signal)), runtime.quality, "sync status response exceeded configured cap");
  }
  if (operation === "records") {
    const model = requiredString(input.model, "model");
    if (source.models.length > 0) assertAllowed(model, source.models, "cave_connect_model_not_allowed");
    return readRecords(
      client,
      source,
      connectionId,
      model,
      typeof input.cursor === "string" ? input.cursor : undefined,
      boundedLimit(input.limit, 20, runtime.quality.maxRecords),
      runtime.quality,
      signal,
    );
  }
  if (operation === "call_action") {
    const action = actionByName(source, requiredString(input.action, "action"));
    const payload = boundActionInput(action, input.input);
    const key = actionIdempotencyKey(source, action, payload);
    if (actionOutcomeUnknown.has(key)) {
      throw new Error(`cave_connect_action_outcome_unknown:${action.name}:verify whether the earlier identical call ran before repeating it`);
    }
    try {
      return boundedResult(structured(await client.call("caveman_tool_call", {
        provider: source.provider,
        connection_id: connectionId,
        action: action.name,
        input: payload,
      }, signal)), runtime.quality, "action completed but response exceeded configured cap; do not retry blindly");
    } catch (error) {
      // No response (timeout/abort) and an executed action whose result broke
      // the byte cap both leave a retry able to fire the side effect twice.
      // Only a daemon-reported failure is known not to have applied.
      if ((error as { message?: unknown } | null)?.message !== "cave_connect_tool_failed") {
        rememberUnknownOutcome(key);
      }
      throw error;
    }
  }
  throw new Error(`cave_connect_operation_invalid:${operation}`);
}

export function createConnect(options: ConnectOptions): ConnectIntegration {
  const sources = normalizeSources(options.sources);
  const quality = normalizeQuality(options.quality);
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, "cave_connect_timeout_invalid");
  const maxCaptureBytes = positiveInteger(
    options.maxCaptureBytes,
    DEFAULT_CAPTURE_BYTES,
    "cave_connect_capture_limit_invalid",
  );
  if (options.binary !== undefined && !isAbsolute(options.binary)) {
    throw new Error("cave_connect_binary_override_not_absolute");
  }
  const runtime: ConnectToolRuntimeDefinition = Object.freeze({
    kind: "caveman-connect",
    sources,
    quality,
    ...(options.binary === undefined ? {} : { binary: options.binary }),
    timeoutMs,
    maxCaptureBytes,
  });
  const definition = tool({
    name: options.toolName ?? "connected_data",
    description: connectToolDescription(sources),
    input: CONNECT_TOOL_INPUT,
    effect: "external",
    result: "inline",
    timeoutMs,
    runtime,
    async execute() {
      throw new Error("cave_connect_framework_runner_required");
    },
  });
  const client = new ConnectRuntime(options);
  return Object.freeze({
    tool: definition,
    sources,
    quality,
    async connect(sourceId: string, onOutput?: ConnectExecuteOptions["onOutput"]): Promise<void> {
      const source = sources.find((candidate) => candidate.id === sourceId);
      if (source === undefined) throw new Error(`cave_connect_source_not_allowed:${sourceId}`);
      await client.connect(source.provider, onOutput);
    },
    async collect(sourceId?: string, signal?: AbortSignal): Promise<readonly unknown[]> {
      const selected = sourceId === undefined
        ? sources
        : sources.filter((source) => source.id === sourceId);
      if (selected.length === 0) throw new Error(`cave_connect_source_not_allowed:${sourceId}`);
      const results: unknown[] = [];
      for (const source of selected) {
        const connectionId = await resolveConnectionId(client, source, signal);
        for (const sync of source.collect) {
          results.push(structured(await client.call("caveman_sync_trigger", {
            provider: source.provider,
            connection_id: connectionId,
            sync,
          }, signal)));
        }
      }
      return Object.freeze(results);
    },
    async connections(signal?: AbortSignal): Promise<readonly ConnectConnection[]> {
      return client.connections(signal);
    },
  });
}

/**
 * Fail-closed local comparison. Token reduction alone never passes: connected
 * run must preserve task success/quality, use complete data, and lower total
 * measured cost after retrieval, retries, and collection.
 */
export function compareConnectEfficiency(
  baseline: ConnectEfficiencyRun,
  connected: ConnectEfficiencyRun,
  options: { readonly maxQualityRegression?: number } = {},
): ConnectEfficiencyComparison {
  const tolerance = options.maxQualityRegression ?? 0;
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new Error("cave_connect_quality_tolerance_invalid");
  }
  const validRun = (run: ConnectEfficiencyRun): boolean =>
    typeof run.taskSuccess === "boolean" &&
    typeof run.completeData === "boolean" &&
    Number.isFinite(run.quality) &&
    (run.providerCostUsd === null || (Number.isFinite(run.providerCostUsd) && run.providerCostUsd >= 0)) &&
    (run.providerInputTokens === null || (Number.isSafeInteger(run.providerInputTokens) && run.providerInputTokens >= 0)) &&
    (run.providerOutputTokens === null || (Number.isSafeInteger(run.providerOutputTokens) && run.providerOutputTokens >= 0)) &&
    Number.isSafeInteger(run.retries) && run.retries >= 0 &&
    Number.isSafeInteger(run.retrievalCalls) && run.retrievalCalls >= 0 &&
    (run.retrievalCostUsd === null || (Number.isFinite(run.retrievalCostUsd) && run.retrievalCostUsd >= 0)) &&
    (run.collectionCostUsd === null || (Number.isFinite(run.collectionCostUsd) && run.collectionCostUsd >= 0));
  if (!validRun(baseline) || !validRun(connected)) throw new Error("cave_connect_efficiency_run_invalid");
  const total = (run: ConnectEfficiencyRun): number | null =>
    run.providerCostUsd === null || run.retrievalCostUsd === null || run.collectionCostUsd === null
    ? null
    : run.providerCostUsd + run.retrievalCostUsd + run.collectionCostUsd;
  const baselineCost = total(baseline);
  const connectedCost = total(connected);
  const qualityDelta = connected.quality - baseline.quality;
  const reasons: string[] = [];
  if (!baseline.taskSuccess) reasons.push("baseline_task_failed");
  if (!baseline.completeData) reasons.push("baseline_data_incomplete");
  if (!connected.taskSuccess) reasons.push("connected_task_failed");
  if (!connected.completeData) reasons.push("connected_data_incomplete");
  if (qualityDelta < -tolerance) reasons.push("quality_regressed");
  if (baselineCost === null || connectedCost === null) reasons.push("cost_incomplete");
  else if (connectedCost >= baselineCost) reasons.push("total_cost_not_lower");
  return Object.freeze({
    evidence: "inferred",
    accepted: reasons.length === 0,
    reasons: Object.freeze(reasons),
    baselineTotalCostUsd: baselineCost,
    connectedTotalCostUsd: connectedCost,
    costDeltaUsd: baselineCost === null || connectedCost === null ? null : connectedCost - baselineCost,
    inputTokenDelta: baseline.providerInputTokens === null || connected.providerInputTokens === null
      ? null
      : connected.providerInputTokens - baseline.providerInputTokens,
    retryDelta: connected.retries - baseline.retries,
    qualityDelta,
  });
}
