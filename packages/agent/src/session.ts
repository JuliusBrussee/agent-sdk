import { createHash, randomUUID } from "node:crypto";
import { snapshotDataRecord } from "./strict-data.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const REVISION = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DEFAULT_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_PAYLOAD_BYTES_PER_SCOPE = 256 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_PAYLOAD_BYTES = 1024 * 1024 * 1024;
const DEFAULT_MAX_RECORDS_PER_SCOPE = 100_000;
const DEFAULT_MAX_TOTAL_RECORDS = 1_000_000;
const DEFAULT_MAX_BRANCHES_PER_SCOPE = 10_000;
const DEFAULT_MAX_TOTAL_BRANCHES = 100_000;
const DEFAULT_MAX_SCOPES = 1_024;

export interface SessionScope {
  readonly tenant: string;
  readonly sessionId: string;
}

export interface SessionBranch {
  readonly branchId: string;
  readonly headRecordId: string | null;
  /** Opaque compare-and-swap token. Never parse or increment client-side. */
  readonly revision: string;
  readonly forkedFromRecordId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type SessionRecordKind = "delta" | "snapshot";

export interface SessionRecord {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly parentId: string | null;
  readonly kind: SessionRecordKind;
  /** Unique logical mutation key within one SessionScope. */
  readonly operationId: string;
  readonly createdAt: string;
  /** Codec-neutral byte-exact payload. */
  readonly payload: Uint8Array;
  readonly payloadSha256: string;
  /** Snapshot only. Equals parentId and marks history reduced by payload. */
  readonly compactsThroughRecordId?: string;
}

export interface SessionWriteResult {
  readonly branch: SessionBranch;
  readonly record: SessionRecord;
  /** Exact logical operation already existed; no second write occurred. */
  readonly replayed: boolean;
}

export interface SessionForkResult {
  readonly branch: SessionBranch;
  readonly replayed: boolean;
}

export interface SessionStore {
  load(input: {
    readonly scope: SessionScope;
    readonly branchId: string;
  }): Promise<SessionBranch | null>;

  path(input: {
    readonly scope: SessionScope;
    readonly recordId: string;
    readonly view?: "effective" | "history";
  }): Promise<readonly SessionRecord[]>;

  append(input: {
    readonly scope: SessionScope;
    readonly branchId: string;
    /** null creates a missing initial branch. */
    readonly expectedRevision: string | null;
    readonly operationId: string;
    readonly payload: Uint8Array;
  }): Promise<SessionWriteResult>;

  fork(input: {
    readonly scope: SessionScope;
    readonly sourceRecordId: string;
    readonly targetBranchId: string;
    readonly operationId: string;
  }): Promise<SessionForkResult>;

  compact(input: {
    readonly scope: SessionScope;
    readonly branchId: string;
    readonly expectedRevision: string;
    readonly operationId: string;
    /** Full reduced state through current branch head. */
    readonly snapshot: Uint8Array;
  }): Promise<SessionWriteResult>;

  listBranches(scope: SessionScope): Promise<readonly SessionBranch[]>;
}

export class SessionConflictError extends Error {
  readonly code = "cave_session_conflict";
  readonly branchId: string;
  readonly expectedRevision: string | null;
  readonly actualRevision: string | null;
  readonly actualHeadRecordId: string | null;

  constructor(input: {
    branchId: string;
    expectedRevision: string | null;
    actualRevision: string | null;
    actualHeadRecordId: string | null;
  }) {
    const defined = snapshotSessionInput(
      input,
      ["branchId", "expectedRevision", "actualRevision", "actualHeadRecordId"],
      ["branchId", "expectedRevision", "actualRevision", "actualHeadRecordId"],
      "conflict",
    );
    const branchId = validateId(defined.branchId, "branch_id");
    const expectedRevision = validateRevision(defined.expectedRevision);
    const actualRevision = validateNullableRevision(defined.actualRevision, "actual_revision");
    const actualHeadRecordId = validateNullableId(
      defined.actualHeadRecordId,
      "actual_head_record_id",
    );
    super(`cave_session_conflict:${branchId}`);
    this.name = "SessionConflictError";
    this.branchId = branchId;
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
    this.actualHeadRecordId = actualHeadRecordId;
  }
}

export interface MemorySessionStoreOptions {
  readonly maxPayloadBytes?: number;
  readonly maxTotalPayloadBytesPerScope?: number;
  readonly maxTotalPayloadBytes?: number;
  readonly maxRecordsPerScope?: number;
  readonly maxTotalRecords?: number;
  readonly maxBranchesPerScope?: number;
  readonly maxTotalBranches?: number;
  readonly maxScopes?: number;
}

type StoredBranch = {
  branchId: string;
  headRecordId: string | null;
  revision: string;
  forkedFromRecordId?: string;
  createdAt: string;
  updatedAt: string;
};

type StoredRecord = Omit<SessionRecord, "payload"> & { payload: Uint8Array };

type StoredOperation =
  | {
    kind: "write";
    fingerprint: string;
    branch: StoredBranch;
    recordId: string;
  }
  | {
    kind: "fork";
    fingerprint: string;
    branch: StoredBranch;
  };

type ScopeState = {
  branches: Map<string, StoredBranch>;
  records: Map<string, StoredRecord>;
  operations: Map<string, StoredOperation>;
  totalPayloadBytes: number;
};

/**
 * Zero-I/O reference implementation for tests and ephemeral agents.
 * Mutations occur synchronously before each returned promise resolves, making
 * compare-and-swap atomic inside one JavaScript process. No state is evicted;
 * per-scope and store-wide limits fail before mutation.
 */
export class MemorySessionStore implements SessionStore {
  readonly #maxPayloadBytes: number;
  readonly #maxTotalPayloadBytesPerScope: number;
  readonly #maxTotalPayloadBytes: number;
  readonly #maxRecordsPerScope: number;
  readonly #maxTotalRecords: number;
  readonly #maxBranchesPerScope: number;
  readonly #maxTotalBranches: number;
  readonly #maxScopes: number;
  readonly #scopes = new Map<string, ScopeState>();
  #totalPayloadBytes = 0;
  #totalRecords = 0;
  #totalBranches = 0;

  constructor(options: MemorySessionStoreOptions = {}) {
    const defined = snapshotSessionInput(options, [
      "maxPayloadBytes",
      "maxTotalPayloadBytesPerScope",
      "maxTotalPayloadBytes",
      "maxRecordsPerScope",
      "maxTotalRecords",
      "maxBranchesPerScope",
      "maxTotalBranches",
      "maxScopes",
    ], [], "options");
    this.#maxPayloadBytes = positiveLimit(
      defined.maxPayloadBytes,
      DEFAULT_MAX_PAYLOAD_BYTES,
    );
    this.#maxTotalPayloadBytesPerScope = positiveLimit(
      defined.maxTotalPayloadBytesPerScope,
      DEFAULT_MAX_TOTAL_PAYLOAD_BYTES_PER_SCOPE,
    );
    this.#maxTotalPayloadBytes = positiveLimit(
      defined.maxTotalPayloadBytes,
      DEFAULT_MAX_TOTAL_PAYLOAD_BYTES,
    );
    this.#maxRecordsPerScope = positiveLimit(
      defined.maxRecordsPerScope,
      DEFAULT_MAX_RECORDS_PER_SCOPE,
    );
    this.#maxTotalRecords = positiveLimit(
      defined.maxTotalRecords,
      DEFAULT_MAX_TOTAL_RECORDS,
    );
    this.#maxBranchesPerScope = positiveLimit(
      defined.maxBranchesPerScope,
      DEFAULT_MAX_BRANCHES_PER_SCOPE,
    );
    this.#maxTotalBranches = positiveLimit(
      defined.maxTotalBranches,
      DEFAULT_MAX_TOTAL_BRANCHES,
    );
    this.#maxScopes = positiveLimit(defined.maxScopes, DEFAULT_MAX_SCOPES);
    if (this.#maxPayloadBytes > this.#maxTotalPayloadBytesPerScope ||
        this.#maxTotalPayloadBytesPerScope > this.#maxTotalPayloadBytes ||
        this.#maxRecordsPerScope > this.#maxTotalRecords ||
        this.#maxBranchesPerScope > this.#maxTotalBranches) {
      throw new Error("cave_session_options_invalid");
    }
  }

  async load(input: {
    readonly scope: SessionScope;
    readonly branchId: string;
  }): Promise<SessionBranch | null> {
    const defined = snapshotSessionInput(
      input,
      ["scope", "branchId"],
      ["scope", "branchId"],
      "load",
    );
    const state = this.#scopes.get(scopeKey(validateScope(defined.scope)));
    const branch = state?.branches.get(validateId(defined.branchId, "branch_id"));
    return branch === undefined ? null : snapshotBranch(branch);
  }

  async path(input: {
    readonly scope: SessionScope;
    readonly recordId: string;
    readonly view?: "effective" | "history";
  }): Promise<readonly SessionRecord[]> {
    const defined = snapshotSessionInput(
      input,
      ["scope", "recordId", "view"],
      ["scope", "recordId"],
      "path",
    );
    const scope = validateScope(defined.scope);
    const state = this.#scopes.get(scopeKey(scope));
    const recordId = validateId(defined.recordId, "record_id");
    const view = defined.view ?? "effective";
    if (view !== "effective" && view !== "history") {
      throw new Error("cave_session_input_invalid:view");
    }
    if (state === undefined || !state.records.has(recordId)) {
      throw new Error(`cave_session_record_not_found:${recordId}`);
    }

    const reversed: SessionRecord[] = [];
    const seen = new Set<string>();
    let cursor: string | null = recordId;
    while (cursor !== null) {
      if (seen.has(cursor)) throw new Error("cave_session_corrupt:record_cycle");
      seen.add(cursor);
      const record = state.records.get(cursor);
      if (record === undefined) throw new Error("cave_session_corrupt:parent_missing");
      validateStoredRecord(record);
      reversed.push(snapshotValidatedRecord(record));
      if (view === "effective" && record.kind === "snapshot") break;
      cursor = record.parentId;
    }
    reversed.reverse();
    return Object.freeze(reversed);
  }

  async append(input: {
    readonly scope: SessionScope;
    readonly branchId: string;
    readonly expectedRevision: string | null;
    readonly operationId: string;
    readonly payload: Uint8Array;
  }): Promise<SessionWriteResult> {
    const defined = snapshotSessionInput(
      input,
      ["scope", "branchId", "expectedRevision", "operationId", "payload"],
      ["scope", "branchId", "expectedRevision", "operationId", "payload"],
      "append",
    );
    const normalized = this.#normalizeWrite(defined, "payload");
    const key = scopeKey(normalized.scope);
    let state = this.#scopes.get(key);
    const fingerprint = operationFingerprint("append", {
      branchId: normalized.branchId,
      expectedRevision: normalized.expectedRevision,
      payloadSha256: normalized.payloadSha256,
    });
    if (state !== undefined) {
      const replay = replayWrite(state, normalized.operationId, fingerprint);
      if (replay !== undefined) return replay;
    }

    const current = state?.branches.get(normalized.branchId);
    assertRevision(normalized.branchId, normalized.expectedRevision, current);
    if (current === undefined && (state?.branches.size ?? 0) >= this.#maxBranchesPerScope) {
      throw new Error("cave_session_capacity_exceeded:branches");
    }
    this.#assertGlobalMutationCapacity(normalized.payload.byteLength, current === undefined);
    if (state === undefined) {
      if (this.#scopes.size >= this.#maxScopes) {
        throw new Error("cave_session_capacity_exceeded:scopes");
      }
      state = newScopeState();
    }
    this.#assertRecordCapacity(state, normalized.payload.byteLength);

    const now = new Date().toISOString();
    const record: StoredRecord = {
      schemaVersion: 1,
      id: `record-${randomUUID()}`,
      parentId: current?.headRecordId ?? null,
      kind: "delta",
      operationId: normalized.operationId,
      createdAt: now,
      payload: normalized.payload,
      payloadSha256: normalized.payloadSha256,
    };
    const branch: StoredBranch = {
      branchId: normalized.branchId,
      headRecordId: record.id,
      revision: nextRevision(),
      ...(current?.forkedFromRecordId === undefined
        ? {}
        : { forkedFromRecordId: current.forkedFromRecordId }),
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    state.records.set(record.id, record);
    state.totalPayloadBytes += record.payload.byteLength;
    state.branches.set(branch.branchId, branch);
    this.#totalPayloadBytes += record.payload.byteLength;
    this.#totalRecords += 1;
    if (current === undefined) this.#totalBranches += 1;
    if (!this.#scopes.has(key)) this.#scopes.set(key, state);
    const result = writeResult(branch, record, false);
    state.operations.set(normalized.operationId, {
      kind: "write",
      fingerprint,
      branch: { ...branch },
      recordId: record.id,
    });
    return result;
  }

  async fork(input: {
    readonly scope: SessionScope;
    readonly sourceRecordId: string;
    readonly targetBranchId: string;
    readonly operationId: string;
  }): Promise<SessionForkResult> {
    const defined = snapshotSessionInput(
      input,
      ["scope", "sourceRecordId", "targetBranchId", "operationId"],
      ["scope", "sourceRecordId", "targetBranchId", "operationId"],
      "fork",
    );
    const scope = validateScope(defined.scope);
    const sourceRecordId = validateId(defined.sourceRecordId, "source_record_id");
    const targetBranchId = validateId(defined.targetBranchId, "target_branch_id");
    const operationId = validateId(defined.operationId, "operation_id");
    const state = this.#scopes.get(scopeKey(scope));
    const fingerprint = operationFingerprint("fork", {
      sourceRecordId,
      targetBranchId,
    });
    if (state !== undefined) {
      const replay = replayFork(state, operationId, fingerprint);
      if (replay !== undefined) return replay;
    }
    if (state === undefined || !state.records.has(sourceRecordId)) {
      throw new Error(`cave_session_record_not_found:${sourceRecordId}`);
    }
    const occupied = state.branches.get(targetBranchId);
    if (occupied !== undefined) {
      throw conflict(targetBranchId, null, occupied);
    }
    if (state.branches.size >= this.#maxBranchesPerScope) {
      throw new Error("cave_session_capacity_exceeded:branches");
    }
    if (this.#totalBranches >= this.#maxTotalBranches) {
      throw new Error("cave_session_capacity_exceeded:total_branches");
    }
    const now = new Date().toISOString();
    const branch: StoredBranch = {
      branchId: targetBranchId,
      headRecordId: sourceRecordId,
      revision: nextRevision(),
      forkedFromRecordId: sourceRecordId,
      createdAt: now,
      updatedAt: now,
    };
    state.branches.set(branch.branchId, branch);
    this.#totalBranches += 1;
    const result = forkResult(branch, false);
    state.operations.set(operationId, {
      kind: "fork",
      fingerprint,
      branch: { ...branch },
    });
    return result;
  }

  async compact(input: {
    readonly scope: SessionScope;
    readonly branchId: string;
    readonly expectedRevision: string;
    readonly operationId: string;
    readonly snapshot: Uint8Array;
  }): Promise<SessionWriteResult> {
    const defined = snapshotSessionInput(
      input,
      ["scope", "branchId", "expectedRevision", "operationId", "snapshot"],
      ["scope", "branchId", "expectedRevision", "operationId", "snapshot"],
      "compact",
    );
    const normalized = this.#normalizeWrite(defined, "snapshot");
    if (normalized.expectedRevision === null) {
      throw new Error("cave_session_input_invalid:expected_revision");
    }
    const state = this.#scopes.get(scopeKey(normalized.scope));
    const fingerprint = operationFingerprint("compact", {
      branchId: normalized.branchId,
      expectedRevision: normalized.expectedRevision,
      payloadSha256: normalized.payloadSha256,
    });
    if (state !== undefined) {
      const replay = replayWrite(state, normalized.operationId, fingerprint);
      if (replay !== undefined) return replay;
    }
    const current = state?.branches.get(normalized.branchId);
    assertRevision(normalized.branchId, normalized.expectedRevision, current);
    if (state === undefined || current === undefined || current.headRecordId === null) {
      throw new Error(`cave_session_branch_not_found:${normalized.branchId}`);
    }
    this.#assertGlobalMutationCapacity(normalized.payload.byteLength, false);
    this.#assertRecordCapacity(state, normalized.payload.byteLength);

    const now = new Date().toISOString();
    const record: StoredRecord = {
      schemaVersion: 1,
      id: `record-${randomUUID()}`,
      parentId: current.headRecordId,
      kind: "snapshot",
      operationId: normalized.operationId,
      createdAt: now,
      payload: normalized.payload,
      payloadSha256: normalized.payloadSha256,
      compactsThroughRecordId: current.headRecordId,
    };
    const branch: StoredBranch = {
      ...current,
      headRecordId: record.id,
      revision: nextRevision(),
      updatedAt: now,
    };
    state.records.set(record.id, record);
    state.totalPayloadBytes += record.payload.byteLength;
    state.branches.set(branch.branchId, branch);
    this.#totalPayloadBytes += record.payload.byteLength;
    this.#totalRecords += 1;
    const result = writeResult(branch, record, false);
    state.operations.set(normalized.operationId, {
      kind: "write",
      fingerprint,
      branch: { ...branch },
      recordId: record.id,
    });
    return result;
  }

  async listBranches(scopeValue: SessionScope): Promise<readonly SessionBranch[]> {
    const scope = validateScope(scopeValue);
    const state = this.#scopes.get(scopeKey(scope));
    if (state === undefined) return Object.freeze([]);
    return Object.freeze(
      [...state.branches.values()]
        .sort((left, right) => compareStrings(left.branchId, right.branchId))
        .map(snapshotBranch),
    );
  }

  #normalizeWrite(
    input: Readonly<Record<string, unknown>>,
    payloadKey: "payload" | "snapshot",
  ): {
    scope: SessionScope;
    branchId: string;
    expectedRevision: string | null;
    operationId: string;
    payload: Uint8Array;
    payloadSha256: string;
  } {
    const scope = validateScope(input.scope);
    const branchId = validateId(input.branchId, "branch_id");
    const expectedRevision = validateRevision(input.expectedRevision);
    const operationId = validateId(input.operationId, "operation_id");
    const payload = snapshotPayload(input[payloadKey], this.#maxPayloadBytes);
    return {
      scope,
      branchId,
      expectedRevision,
      operationId,
      payload,
      payloadSha256: digest(payload),
    };
  }

  #assertRecordCapacity(state: ScopeState, payloadBytes: number): void {
    if (state.records.size >= this.#maxRecordsPerScope) {
      throw new Error("cave_session_capacity_exceeded:records");
    }
    if (state.totalPayloadBytes + payloadBytes > this.#maxTotalPayloadBytesPerScope) {
      throw new Error("cave_session_capacity_exceeded:payload_bytes");
    }
  }

  #assertGlobalMutationCapacity(payloadBytes: number, createsBranch: boolean): void {
    if (this.#totalRecords >= this.#maxTotalRecords) {
      throw new Error("cave_session_capacity_exceeded:total_records");
    }
    if (this.#totalPayloadBytes + payloadBytes > this.#maxTotalPayloadBytes) {
      throw new Error("cave_session_capacity_exceeded:total_payload_bytes");
    }
    if (createsBranch && this.#totalBranches >= this.#maxTotalBranches) {
      throw new Error("cave_session_capacity_exceeded:total_branches");
    }
  }
}

function newScopeState(): ScopeState {
  return {
    branches: new Map(),
    records: new Map(),
    operations: new Map(),
    totalPayloadBytes: 0,
  };
}

function replayWrite(
  state: ScopeState,
  operationId: string,
  fingerprint: string,
): SessionWriteResult | undefined {
  const operation = state.operations.get(operationId);
  if (operation === undefined) return undefined;
  if (operation.fingerprint !== fingerprint || operation.kind !== "write") {
    throw new Error(`cave_session_operation_mismatch:${operationId}`);
  }
  const record = state.records.get(operation.recordId);
  if (record === undefined) throw new Error("cave_session_corrupt:operation_record_missing");
  return writeResult(operation.branch, record, true);
}

function replayFork(
  state: ScopeState,
  operationId: string,
  fingerprint: string,
): SessionForkResult | undefined {
  const operation = state.operations.get(operationId);
  if (operation === undefined) return undefined;
  if (operation.fingerprint !== fingerprint || operation.kind !== "fork") {
    throw new Error(`cave_session_operation_mismatch:${operationId}`);
  }
  return forkResult(operation.branch, true);
}

function assertRevision(
  branchId: string,
  expectedRevision: string | null,
  branch: StoredBranch | undefined,
): void {
  const actualRevision = branch?.revision ?? null;
  if (actualRevision !== expectedRevision) {
    throw conflict(branchId, expectedRevision, branch);
  }
}

function conflict(
  branchId: string,
  expectedRevision: string | null,
  branch: StoredBranch | undefined,
): SessionConflictError {
  return new SessionConflictError({
    branchId,
    expectedRevision,
    actualRevision: branch?.revision ?? null,
    actualHeadRecordId: branch?.headRecordId ?? null,
  });
}

function writeResult(
  branch: StoredBranch,
  record: StoredRecord,
  replayed: boolean,
): SessionWriteResult {
  return Object.freeze({
    branch: snapshotBranch(branch),
    record: snapshotRecord(record),
    replayed,
  });
}

function forkResult(branch: StoredBranch, replayed: boolean): SessionForkResult {
  return Object.freeze({ branch: snapshotBranch(branch), replayed });
}

function snapshotBranch(branch: SessionBranch): SessionBranch {
  return Object.freeze({
    branchId: branch.branchId,
    headRecordId: branch.headRecordId,
    revision: branch.revision,
    ...(branch.forkedFromRecordId === undefined
      ? {}
      : { forkedFromRecordId: branch.forkedFromRecordId }),
    createdAt: branch.createdAt,
    updatedAt: branch.updatedAt,
  });
}

function snapshotRecord(record: SessionRecord): SessionRecord {
  validateStoredRecord(record);
  return snapshotValidatedRecord(record);
}

function snapshotValidatedRecord(record: SessionRecord): SessionRecord {
  return Object.freeze({
    schemaVersion: 1,
    id: record.id,
    parentId: record.parentId,
    kind: record.kind,
    operationId: record.operationId,
    createdAt: record.createdAt,
    payload: new Uint8Array(record.payload),
    payloadSha256: record.payloadSha256,
    ...(record.compactsThroughRecordId === undefined
      ? {}
      : { compactsThroughRecordId: record.compactsThroughRecordId }),
  });
}

function validateStoredRecord(record: SessionRecord): void {
  if (record.schemaVersion !== 1 || !ID.test(record.id) ||
      (record.parentId !== null && !ID.test(record.parentId)) ||
      (record.kind !== "delta" && record.kind !== "snapshot") ||
      !ID.test(record.operationId) || !SHA256.test(record.payloadSha256) ||
      digest(record.payload) !== record.payloadSha256) {
    throw new Error("cave_session_corrupt:record_invalid");
  }
  if (record.kind === "snapshot") {
    if (record.parentId === null ||
        record.compactsThroughRecordId !== record.parentId) {
      throw new Error("cave_session_corrupt:snapshot_boundary");
    }
  } else if (record.compactsThroughRecordId !== undefined) {
    throw new Error("cave_session_corrupt:delta_compaction_boundary");
  }
}

function validateScope(value: unknown): SessionScope {
  const defined = snapshotSessionInput(
    value,
    ["tenant", "sessionId"],
    ["tenant", "sessionId"],
    "scope",
  );
  return Object.freeze({
    tenant: validateId(defined.tenant, "tenant"),
    sessionId: validateId(defined.sessionId, "session_id"),
  });
}

function validateId(value: unknown, field: string): string {
  if (typeof value !== "string" || !ID.test(value)) {
    throw new Error(`cave_session_input_invalid:${field}`);
  }
  return value;
}

function validateRevision(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !REVISION.test(value)) {
    throw new Error("cave_session_input_invalid:expected_revision");
  }
  return value;
}

function validateNullableRevision(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !REVISION.test(value)) {
    throw new Error(`cave_session_input_invalid:${field}`);
  }
  return value;
}

function validateNullableId(value: unknown, field: string): string | null {
  if (value === null) return null;
  return validateId(value, field);
}

function snapshotPayload(value: unknown, maximum: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.buffer instanceof SharedArrayBuffer) {
    throw new Error("cave_session_input_invalid:payload");
  }
  if (value.byteLength > maximum) {
    throw new Error("cave_session_payload_too_large");
  }
  return new Uint8Array(value);
}

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function scopeKey(scope: SessionScope): string {
  return JSON.stringify([scope.tenant, scope.sessionId]);
}

function operationFingerprint(kind: string, value: Record<string, unknown>): string {
  return JSON.stringify([kind, Object.entries(value).sort(([left], [right]) =>
    compareStrings(left, right))]);
}

function nextRevision(): string {
  return `revision-${randomUUID()}`;
}

function positiveLimit(value: unknown, fallback: number): number {
  const resolved = value ?? fallback;
  if (typeof resolved !== "number" || !Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error("cave_session_options_invalid");
  }
  return resolved;
}

function snapshotSessionInput(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
  field: string,
): Readonly<Record<string, unknown>> {
  return snapshotDataRecord(value, allowed, required, () => {
    throw new Error(field === "options"
      ? "cave_session_options_invalid"
      : `cave_session_input_invalid:${field}`);
  });
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
