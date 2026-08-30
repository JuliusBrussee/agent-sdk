import {
  defineRuntimeDescriptor,
  type RuntimeDescriptor,
} from "./runtime-descriptor.js";
import { abortable } from "./async-boundary.js";
import { snapshotDataRecord, snapshotDenseArray } from "./strict-data.js";

export interface CheckpointArtifactEvidence {
  readonly name: string;
  readonly digest: `sha256:${string}`;
  readonly bytes?: number;
  readonly mediaType?: string;
}

export interface CheckpointEvidence {
  readonly schemaVersion: 1;
  readonly providerId: string;
  readonly ref: string;
  readonly sequence: number;
  readonly createdAt: string;
  readonly rootDigest: `sha256:${string}`;
  readonly completeness: "complete" | "partial" | "unknown";
  readonly artifacts: readonly CheckpointArtifactEvidence[];
  readonly omissionCount: number;
  readonly runtime: RuntimeDescriptor;
}

export interface CheckpointCaptureRequest {
  readonly sessionId: string;
  readonly runId: string;
  readonly stepId: string;
  readonly reason: "before_step" | "after_step" | "manual";
  readonly previousRef?: string;
  readonly signal?: AbortSignal;
}

export interface CheckpointRestoreRequest {
  readonly sessionId: string;
  readonly ref: string;
  readonly expectedRootDigest?: `sha256:${string}`;
  readonly signal?: AbortSignal;
}

export interface CheckpointRestoreEvidence {
  readonly ref: string;
  readonly restoredAt: string;
  readonly beforeRootDigest: `sha256:${string}`;
  readonly afterRootDigest: `sha256:${string}`;
  readonly changedPathCount: number;
  readonly runtime: RuntimeDescriptor;
}

export interface CheckpointComparison {
  readonly fromRef: string;
  readonly toRef: string;
  readonly changedPathCount: number;
  readonly addedBytes?: number;
  readonly removedBytes?: number;
  readonly artifacts: readonly CheckpointArtifactEvidence[];
}

export interface CheckpointHooks {
  capture(
    request: Readonly<CheckpointCaptureRequest>,
  ): CheckpointEvidence | PromiseLike<CheckpointEvidence>;
  restore(
    request: Readonly<CheckpointRestoreRequest>,
  ): CheckpointRestoreEvidence | PromiseLike<CheckpointRestoreEvidence>;
  compare?(
    fromRef: string,
    toRef: string,
    signal?: AbortSignal,
  ): CheckpointComparison | PromiseLike<CheckpointComparison>;
}

const ARTIFACT_KEYS = Object.freeze(["name", "digest", "bytes", "mediaType"]);
const EVIDENCE_KEYS = Object.freeze([
  "schemaVersion",
  "providerId",
  "ref",
  "sequence",
  "createdAt",
  "rootDigest",
  "completeness",
  "artifacts",
  "omissionCount",
  "runtime",
]);
const CAPTURE_KEYS = Object.freeze([
  "sessionId",
  "runId",
  "stepId",
  "reason",
  "previousRef",
  "signal",
]);
const RESTORE_REQUEST_KEYS = Object.freeze([
  "sessionId",
  "ref",
  "expectedRootDigest",
  "signal",
]);
const RESTORE_EVIDENCE_KEYS = Object.freeze([
  "ref",
  "restoredAt",
  "beforeRootDigest",
  "afterRootDigest",
  "changedPathCount",
  "runtime",
]);
const COMPARISON_KEYS = Object.freeze([
  "fromRef",
  "toRef",
  "changedPathCount",
  "addedBytes",
  "removedBytes",
  "artifacts",
]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const MEDIA_TYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+/-]{0,255}$/;
const COMPLETENESS = Object.freeze(["complete", "partial", "unknown"]);
const CAPTURE_REASONS = Object.freeze(["before_step", "after_step", "manual"]);
const MAX_ARTIFACTS = 10_000;
const MAX_ARTIFACT_NAME_BYTES = 1024 * 1024;

export function defineCheckpointEvidence(value: unknown): CheckpointEvidence {
  const evidence = snapshotRecord(value, EVIDENCE_KEYS, EVIDENCE_KEYS, "evidence");
  if (evidence.schemaVersion !== 1) fail("schema_version");
  requireText(evidence.providerId, ID, "provider_id");
  requireRef(evidence.ref, "ref");
  requireNonNegativeInteger(evidence.sequence, "sequence");
  requireTimestamp(evidence.createdAt, "created_at");
  requireText(evidence.rootDigest, SHA256, "root_digest");
  requireOneOf(evidence.completeness, COMPLETENESS, "completeness");
  requireNonNegativeInteger(evidence.omissionCount, "omission_count");
  if (evidence.completeness === "complete" && evidence.omissionCount !== 0) {
    fail("completeness");
  }
  const artifacts = normalizeArtifacts(evidence.artifacts);
  return Object.freeze({
    schemaVersion: 1,
    providerId: evidence.providerId as string,
    ref: evidence.ref as string,
    sequence: evidence.sequence as number,
    createdAt: evidence.createdAt as string,
    rootDigest: evidence.rootDigest as `sha256:${string}`,
    completeness: evidence.completeness as CheckpointEvidence["completeness"],
    artifacts,
    omissionCount: evidence.omissionCount as number,
    runtime: defineRuntimeDescriptor(evidence.runtime),
  });
}

export function defineCheckpointRestoreEvidence(value: unknown): CheckpointRestoreEvidence {
  const evidence = snapshotRecord(
    value,
    RESTORE_EVIDENCE_KEYS,
    RESTORE_EVIDENCE_KEYS,
    "restore_evidence",
  );
  requireRef(evidence.ref, "ref");
  requireTimestamp(evidence.restoredAt, "restored_at");
  requireText(evidence.beforeRootDigest, SHA256, "before_root_digest");
  requireText(evidence.afterRootDigest, SHA256, "after_root_digest");
  requireNonNegativeInteger(evidence.changedPathCount, "changed_path_count");
  return Object.freeze({
    ref: evidence.ref as string,
    restoredAt: evidence.restoredAt as string,
    beforeRootDigest: evidence.beforeRootDigest as `sha256:${string}`,
    afterRootDigest: evidence.afterRootDigest as `sha256:${string}`,
    changedPathCount: evidence.changedPathCount as number,
    runtime: defineRuntimeDescriptor(evidence.runtime),
  });
}

export function defineCheckpointComparison(value: unknown): CheckpointComparison {
  const comparison = snapshotRecord(value, COMPARISON_KEYS, [
    "fromRef",
    "toRef",
    "changedPathCount",
    "artifacts",
  ], "comparison");
  requireRef(comparison.fromRef, "from_ref");
  requireRef(comparison.toRef, "to_ref");
  requireNonNegativeInteger(comparison.changedPathCount, "changed_path_count");
  if (comparison.addedBytes !== undefined) {
    requireNonNegativeInteger(comparison.addedBytes, "added_bytes");
  }
  if (comparison.removedBytes !== undefined) {
    requireNonNegativeInteger(comparison.removedBytes, "removed_bytes");
  }
  return Object.freeze({
    fromRef: comparison.fromRef as string,
    toRef: comparison.toRef as string,
    changedPathCount: comparison.changedPathCount as number,
    ...(comparison.addedBytes === undefined ? {} : { addedBytes: comparison.addedBytes as number }),
    ...(comparison.removedBytes === undefined ? {} : { removedBytes: comparison.removedBytes as number }),
    artifacts: normalizeArtifacts(comparison.artifacts),
  });
}

export async function captureCheckpoint(
  hooks: CheckpointHooks,
  requestValue: CheckpointCaptureRequest,
): Promise<CheckpointEvidence> {
  const capture = requireHook(hooks, "capture");
  const request = normalizeCaptureRequest(requestValue);
  throwIfAborted(request.signal);
  try {
    const evidence = await abortable(
      capture(request),
      request.signal,
      () => new Error("cave_checkpoint_aborted"),
    );
    throwIfAborted(request.signal);
    return defineCheckpointEvidence(evidence);
  } catch {
    throwIfAborted(request.signal);
    throw new Error("cave_checkpoint_capture_failed");
  }
}

export async function restoreCheckpoint(
  hooks: CheckpointHooks,
  requestValue: CheckpointRestoreRequest,
): Promise<CheckpointRestoreEvidence> {
  const restore = requireHook(hooks, "restore");
  const request = normalizeRestoreRequest(requestValue);
  throwIfAborted(request.signal);
  let evidence: CheckpointRestoreEvidence;
  try {
    // Restore is effectful. Cancellation cannot claim quiescence while a hook
    // that ignores its signal may still mutate state, so await raw settlement.
    const rawEvidence = await restore(request);
    throwIfAborted(request.signal);
    evidence = defineCheckpointRestoreEvidence(rawEvidence);
    throwIfAborted(request.signal);
  } catch {
    throwIfAborted(request.signal);
    throw new Error("cave_checkpoint_restore_failed");
  }
  if (evidence.ref !== request.ref ||
      (request.expectedRootDigest !== undefined &&
        evidence.afterRootDigest !== request.expectedRootDigest)) {
    throw new Error("cave_checkpoint_restore_mismatch");
  }
  return evidence;
}

export async function compareCheckpoints(
  hooks: CheckpointHooks,
  fromRefValue: string,
  toRefValue: string,
  signal?: AbortSignal,
): Promise<CheckpointComparison> {
  const compare = requireHook(hooks, "compare", true);
  if (compare === undefined) throw new Error("cave_checkpoint_compare_unsupported");
  requireRef(fromRefValue, "from_ref");
  requireRef(toRefValue, "to_ref");
  requireSignal(signal);
  throwIfAborted(signal);
  let result: CheckpointComparison;
  try {
    const rawResult = await abortable(
      compare(fromRefValue, toRefValue, signal),
      signal,
      () => new Error("cave_checkpoint_aborted"),
    );
    throwIfAborted(signal);
    result = defineCheckpointComparison(rawResult);
    throwIfAborted(signal);
  } catch {
    throwIfAborted(signal);
    throw new Error("cave_checkpoint_compare_failed");
  }
  if (result.fromRef !== fromRefValue || result.toRef !== toRefValue) {
    throw new Error("cave_checkpoint_compare_mismatch");
  }
  return result;
}

function normalizeCaptureRequest(value: unknown): Readonly<CheckpointCaptureRequest> {
  const request = snapshotRecord(
    value,
    CAPTURE_KEYS,
    ["sessionId", "runId", "stepId", "reason"],
    "capture_request",
  );
  requireText(request.sessionId, ID, "session_id");
  requireText(request.runId, ID, "run_id");
  requireText(request.stepId, ID, "step_id");
  requireOneOf(request.reason, CAPTURE_REASONS, "capture_reason");
  if (request.previousRef !== undefined) requireRef(request.previousRef, "previous_ref");
  requireSignal(request.signal);
  return Object.freeze({
    sessionId: request.sessionId as string,
    runId: request.runId as string,
    stepId: request.stepId as string,
    reason: request.reason as CheckpointCaptureRequest["reason"],
    ...(request.previousRef === undefined ? {} : { previousRef: request.previousRef as string }),
    ...(request.signal === undefined ? {} : { signal: request.signal as AbortSignal }),
  });
}

function normalizeRestoreRequest(value: unknown): Readonly<CheckpointRestoreRequest> {
  const request = snapshotRecord(
    value,
    RESTORE_REQUEST_KEYS,
    ["sessionId", "ref"],
    "restore_request",
  );
  requireText(request.sessionId, ID, "session_id");
  requireRef(request.ref, "ref");
  if (request.expectedRootDigest !== undefined) {
    requireText(request.expectedRootDigest, SHA256, "expected_root_digest");
  }
  requireSignal(request.signal);
  return Object.freeze({
    sessionId: request.sessionId as string,
    ref: request.ref as string,
    ...(request.expectedRootDigest === undefined
      ? {}
      : { expectedRootDigest: request.expectedRootDigest as `sha256:${string}` }),
    ...(request.signal === undefined ? {} : { signal: request.signal as AbortSignal }),
  });
}

function normalizeArtifacts(value: unknown): readonly CheckpointArtifactEvidence[] {
  const values = snapshotDenseArray(value, MAX_ARTIFACTS, () => fail("artifacts"));
  const seen = new Set<string>();
  let nameBytes = 0;
  const artifacts = values.map((value) => {
    const artifact = snapshotRecord(value, ARTIFACT_KEYS, ["name", "digest"], "artifact");
    requireArtifactName(artifact.name);
    if ((artifact.name as string).split("/").some((part) => part === "..") ||
        seen.has(artifact.name as string)) {
      fail("artifact_name");
    }
    seen.add(artifact.name as string);
    nameBytes += Buffer.byteLength(artifact.name as string);
    if (nameBytes > MAX_ARTIFACT_NAME_BYTES) fail("artifact_name_bytes");
    requireText(artifact.digest, SHA256, "artifact_digest");
    if (artifact.bytes !== undefined) requireNonNegativeInteger(artifact.bytes, "artifact_bytes");
    if (artifact.mediaType !== undefined) requireText(artifact.mediaType, MEDIA_TYPE, "artifact_media_type");
    return Object.freeze({
      name: artifact.name as string,
      digest: artifact.digest as `sha256:${string}`,
      ...(artifact.bytes === undefined ? {} : { bytes: artifact.bytes as number }),
      ...(artifact.mediaType === undefined ? {} : { mediaType: artifact.mediaType as string }),
    });
  });
  return Object.freeze(artifacts);
}

function requireHook(
  hooks: unknown,
  name: "capture",
  optional?: false,
): CheckpointHooks["capture"];
function requireHook(
  hooks: unknown,
  name: "restore",
  optional?: false,
): CheckpointHooks["restore"];
function requireHook(
  hooks: unknown,
  name: "compare",
  optional: true,
): CheckpointHooks["compare"];
function requireHook(
  hooks: unknown,
  name: "capture" | "restore" | "compare",
  optional = false,
): ((...args: never[]) => unknown) | undefined {
  if (hooks === null || (typeof hooks !== "object" && typeof hooks !== "function")) fail("hooks");
  let hook: unknown;
  try {
    hook = Reflect.get(hooks, name);
  } catch {
    fail("hooks");
  }
  if (hook === undefined && optional) return undefined;
  if (typeof hook !== "function") fail("hooks");
  return ((...args: never[]) => Reflect.apply(hook, hooks, args)) as
    (...args: never[]) => unknown;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new Error("cave_checkpoint_aborted");
}

function requireSignal(value: unknown): void {
  if (value !== undefined && !(value instanceof AbortSignal)) fail("signal");
}

function requireTimestamp(value: unknown, field: string): void {
  if (typeof value !== "string" || value.length > 40) fail(field);
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf()) || date.toISOString() !== value) fail(field);
}

function requireNonNegativeInteger(value: unknown, field: string): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail(field);
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

function requireRef(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048 ||
      /[\0\r\n]/u.test(value)) {
    fail(field);
  }
}

function requireArtifactName(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1_024 ||
      value.startsWith("/") || /[\0\r\n]/u.test(value)) {
    fail("artifact_name");
  }
}

function requireOneOf(value: unknown, choices: readonly string[], field: string): void {
  if (typeof value !== "string" || !choices.includes(value)) fail(field);
}

function fail(field: string): never {
  throw new Error(`cave_checkpoint_invalid:${field}`);
}
