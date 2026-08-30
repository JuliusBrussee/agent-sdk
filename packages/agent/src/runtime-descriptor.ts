export type RuntimeEvidenceState = "enforced" | "unsupported" | "unknown";

export interface RuntimeDescriptor {
  readonly schemaVersion: 1;
  readonly backend: {
    readonly id: string;
    readonly version?: string;
  };
  readonly containment: "os" | "vm" | "uncontained" | "unknown";
  readonly filesystem: {
    readonly read: "none" | "staged" | "workspace" | "unrestricted" | "unknown";
    readonly write: "none" | "ephemeral" | "workspace" | "unrestricted" | "unknown";
  };
  readonly network: "none" | "host_allowlist" | "unrestricted" | "unknown";
  readonly subprocess: "none" | "contained" | "uncontained" | "unknown";
  readonly limits: {
    readonly deadline: RuntimeEvidenceState;
    readonly outputBytes: RuntimeEvidenceState;
    readonly memory: RuntimeEvidenceState;
    readonly cpu: RuntimeEvidenceState;
  };
  readonly evidence: {
    readonly basis: "live_probe" | "backend_contract" | "host";
    readonly observedAt?: string;
    readonly digest?: `sha256:${string}`;
  };
}

export interface RuntimeDescriptorProvider {
  describe(signal?: AbortSignal): RuntimeDescriptor | PromiseLike<RuntimeDescriptor>;
}

export interface HostRuntimeDescriptorInput {
  readonly backend: RuntimeDescriptor["backend"];
  readonly filesystem: RuntimeDescriptor["filesystem"];
  readonly network: RuntimeDescriptor["network"];
  readonly subprocess: RuntimeDescriptor["subprocess"];
  readonly limits: RuntimeDescriptor["limits"];
  readonly observedAt?: string;
  readonly digest?: `sha256:${string}`;
}

const DESCRIPTOR_KEYS = Object.freeze([
  "schemaVersion",
  "backend",
  "containment",
  "filesystem",
  "network",
  "subprocess",
  "limits",
  "evidence",
]);
const BACKEND_KEYS = Object.freeze(["id", "version"]);
const FILESYSTEM_KEYS = Object.freeze(["read", "write"]);
const LIMIT_KEYS = Object.freeze(["deadline", "outputBytes", "memory", "cpu"]);
const EVIDENCE_KEYS = Object.freeze(["basis", "observedAt", "digest"]);
const HOST_INPUT_KEYS = Object.freeze([
  "backend",
  "filesystem",
  "network",
  "subprocess",
  "limits",
  "observedAt",
  "digest",
]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const READ_STATES = Object.freeze(["none", "staged", "workspace", "unrestricted", "unknown"]);
const WRITE_STATES = Object.freeze(["none", "ephemeral", "workspace", "unrestricted", "unknown"]);
const NETWORK_STATES = Object.freeze(["none", "host_allowlist", "unrestricted", "unknown"]);
const SUBPROCESS_STATES = Object.freeze(["none", "contained", "uncontained", "unknown"]);
const CONTAINMENT_STATES = Object.freeze(["os", "vm", "uncontained", "unknown"]);
const EVIDENCE_STATES = Object.freeze(["enforced", "unsupported", "unknown"]);
const EVIDENCE_BASES = Object.freeze(["live_probe", "backend_contract", "host"]);

/** Validate and detach runtime facts. This contract never executes work. */
export function defineRuntimeDescriptor(value: unknown): RuntimeDescriptor {
  const descriptor = snapshotRecord(value, DESCRIPTOR_KEYS, DESCRIPTOR_KEYS, "descriptor");
  if (descriptor.schemaVersion !== 1) fail("schema_version");

  const backendValue = snapshotRecord(descriptor.backend, BACKEND_KEYS, ["id"], "backend");
  requireText(backendValue.id, ID, "backend_id");
  if (backendValue.version !== undefined) {
    requireText(backendValue.version, VERSION, "backend_version");
  }

  requireOneOf(descriptor.containment, CONTAINMENT_STATES, "containment");
  const filesystem = snapshotRecord(
    descriptor.filesystem,
    FILESYSTEM_KEYS,
    FILESYSTEM_KEYS,
    "filesystem",
  );
  requireOneOf(filesystem.read, READ_STATES, "filesystem_read");
  requireOneOf(filesystem.write, WRITE_STATES, "filesystem_write");
  requireOneOf(descriptor.network, NETWORK_STATES, "network");
  requireOneOf(descriptor.subprocess, SUBPROCESS_STATES, "subprocess");

  const limits = snapshotRecord(descriptor.limits, LIMIT_KEYS, LIMIT_KEYS, "limits");
  for (const key of LIMIT_KEYS) {
    requireOneOf(limits[key], EVIDENCE_STATES, `limit_${key}`);
  }

  const evidenceValue = snapshotRecord(
    descriptor.evidence,
    EVIDENCE_KEYS,
    ["basis"],
    "evidence",
  );
  requireOneOf(evidenceValue.basis, EVIDENCE_BASES, "evidence_basis");
  if (evidenceValue.observedAt !== undefined) {
    requireTimestamp(evidenceValue.observedAt);
  }
  if (evidenceValue.digest !== undefined) {
    requireText(evidenceValue.digest, SHA256, "evidence_digest");
  }
  if (evidenceValue.basis === "host" && descriptor.containment !== "uncontained") {
    fail("host_containment");
  }

  const backend: { id: string; version?: string } = { id: backendValue.id as string };
  if (backendValue.version !== undefined) backend.version = backendValue.version as string;
  const evidence: {
    basis: "live_probe" | "backend_contract" | "host";
    observedAt?: string;
    digest?: `sha256:${string}`;
  } = { basis: evidenceValue.basis as "live_probe" | "backend_contract" | "host" };
  if (evidenceValue.observedAt !== undefined) {
    evidence.observedAt = evidenceValue.observedAt as string;
  }
  if (evidenceValue.digest !== undefined) {
    evidence.digest = evidenceValue.digest as `sha256:${string}`;
  }
  return Object.freeze({
    schemaVersion: 1,
    backend: Object.freeze(backend),
    containment: descriptor.containment as RuntimeDescriptor["containment"],
    filesystem: Object.freeze({
      read: filesystem.read as RuntimeDescriptor["filesystem"]["read"],
      write: filesystem.write as RuntimeDescriptor["filesystem"]["write"],
    }),
    network: descriptor.network as RuntimeDescriptor["network"],
    subprocess: descriptor.subprocess as RuntimeDescriptor["subprocess"],
    limits: Object.freeze({
      deadline: limits.deadline as RuntimeEvidenceState,
      outputBytes: limits.outputBytes as RuntimeEvidenceState,
      memory: limits.memory as RuntimeEvidenceState,
      cpu: limits.cpu as RuntimeEvidenceState,
    }),
    evidence: Object.freeze(evidence),
  });
}

/** Construct descriptor for direct host execution. Containment is always uncontained. */
export function defineHostRuntimeDescriptor(input: HostRuntimeDescriptorInput): RuntimeDescriptor {
  const host = snapshotRecord(input, HOST_INPUT_KEYS, [
    "backend",
    "filesystem",
    "network",
    "subprocess",
    "limits",
  ], "host_input");
  return defineRuntimeDescriptor({
    schemaVersion: 1,
    backend: host.backend,
    containment: "uncontained",
    filesystem: host.filesystem,
    network: host.network,
    subprocess: host.subprocess,
    limits: host.limits,
    evidence: {
      basis: "host",
      ...(host.observedAt === undefined ? {} : { observedAt: host.observedAt }),
      ...(host.digest === undefined ? {} : { digest: host.digest }),
    },
  });
}

/** Read facts once; provider errors become fixed diagnostics with no leaked cause. */
export async function readRuntimeDescriptor(
  provider: RuntimeDescriptorProvider,
  signal?: AbortSignal,
): Promise<RuntimeDescriptor> {
  const describe = requireProviderDescribe(provider);
  requireSignal(signal);
  if (isAborted(signal)) throw new Error("cave_runtime_descriptor_aborted");
  let value: RuntimeDescriptor;
  try {
    value = await abortable(
      Reflect.apply(describe, provider, [signal]),
      signal,
      () => new Error("cave_runtime_descriptor_aborted"),
    );
  } catch {
    if (isAborted(signal)) throw new Error("cave_runtime_descriptor_aborted");
    throw new Error("cave_runtime_descriptor_provider_failed");
  }
  if (isAborted(signal)) throw new Error("cave_runtime_descriptor_aborted");
  return defineRuntimeDescriptor(value);
}

function requireProviderDescribe(value: unknown): Function {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    fail("provider");
  }
  let describe: unknown;
  try {
    describe = Reflect.get(value, "describe");
  } catch {
    fail("provider");
  }
  if (typeof describe !== "function") fail("provider");
  return describe;
}

function requireTimestamp(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length > 40) fail("evidence_observed_at");
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    fail("evidence_observed_at");
  }
}

function requireSignal(value: unknown): void {
  if (value !== undefined && !(value instanceof AbortSignal)) fail("signal");
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function snapshotRecord(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
  field: string,
): Readonly<Record<string, unknown>> {
  return snapshotDataRecord(value, allowed, required, () => fail(field));
}

function requireText(value: unknown, pattern: RegExp, field: string): asserts value is string {
  if (typeof value !== "string" || !pattern.test(value)) fail(field);
}

function requireOneOf(
  value: unknown,
  choices: readonly string[],
  field: string,
): asserts value is string {
  if (typeof value !== "string" || !choices.includes(value)) fail(field);
}

function fail(field: string): never {
  throw new Error(`cave_runtime_descriptor_invalid:${field}`);
}
import { abortable } from "./async-boundary.js";
import { snapshotDataRecord } from "./strict-data.js";
