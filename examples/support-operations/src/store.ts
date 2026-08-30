import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  DomainError,
  emptySupportState,
  fingerprint,
  type AnalysisResult,
  type AuditEvent,
  type CaseInput,
  type Order,
  type Principal,
  type SupportCase,
  type SupportState,
} from "./domain.js";

interface IdempotentResponse<T> {
  replayed: boolean;
  statusCode: number;
  body: T;
}

type AnalysisReservation =
  | { replayed: true; statusCode: number; body: unknown }
  | {
    replayed: false;
    runId: string;
    supportCase: SupportCase;
    order: Order;
  };

export class FileSupportStore {
  private state: SupportState | undefined;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(
    readonly path: string,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async initialize(seedOrders: readonly Order[]): Promise<void> {
    await this.serial(async () => {
      if (this.state !== undefined) return;
      try {
        const parsed = JSON.parse(await readFile(this.path, "utf8")) as SupportState;
        if (parsed.schemaVersion !== 2 || !Array.isArray(parsed.cases) ||
            !Array.isArray(parsed.orders) ||
            !Array.isArray(parsed.audit) || parsed.idempotency === null ||
            typeof parsed.idempotency !== "object") {
          throw new Error("support_state_invalid");
        }
        this.state = parsed;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        this.state = emptySupportState(seedOrders);
        await this.persist(this.state);
      }
    });
  }

  async readiness(): Promise<{ ready: true; storage: "single_process_file" }> {
    this.requireState();
    return { ready: true, storage: "single_process_file" };
  }

  async createCase(
    principal: Principal,
    key: string,
    input: CaseInput,
  ): Promise<IdempotentResponse<SupportCase>> {
    return this.transaction((state) => {
      const operation = `${principal.tenantId}:case:create:${key}`;
      const requestFingerprint = fingerprint(input);
      const replay = completed<SupportCase>(state, operation, requestFingerprint);
      if (replay) return replay;
      if (!state.orders.some((order) =>
        order.tenantId === principal.tenantId && order.id === input.orderId)) {
        throw new DomainError("order_not_found", 404);
      }
      const duplicate = state.cases.find((supportCase) =>
        supportCase.tenantId === principal.tenantId &&
        supportCase.externalId === input.externalId);
      if (duplicate) throw new DomainError("case_external_id_conflict", 409);
      const now = this.clock().toISOString();
      const supportCase: SupportCase = {
        id: `case_${randomUUID()}`,
        tenantId: principal.tenantId,
        ...input,
        status: "received",
        proposal: null,
        receipt: null,
        createdAt: now,
        updatedAt: now,
      };
      state.cases.push(supportCase);
      audit(state, principal, "case.created", "case", supportCase.id, {}, now);
      const response = structuredClone(supportCase);
      state.idempotency[operation] = {
        fingerprint: requestFingerprint,
        state: "complete",
        statusCode: 201,
        body: response,
      };
      return { replayed: false, statusCode: 201, body: response };
    });
  }

  async reserveAnalysis(
    principal: Principal,
    key: string,
    caseId: string,
  ): Promise<AnalysisReservation> {
    return this.transaction((state) => {
      const operation = `${principal.tenantId}:case:analyze:${key}`;
      const requestFingerprint = fingerprint({ caseId });
      const existing = state.idempotency[operation];
      if (existing) {
        if (existing.fingerprint !== requestFingerprint) {
          throw new DomainError("idempotency_key_conflict", 409);
        }
        if (existing.state === "running") throw new DomainError("analysis_in_progress", 409);
        return {
          replayed: true,
          statusCode: existing.statusCode!,
          body: structuredClone(existing.body),
        };
      }
      const supportCase = tenantCase(state, principal.tenantId, caseId);
      if (!supportCase) throw new DomainError("case_not_found", 404);
      if (!(["received", "analysis_failed"] as string[]).includes(supportCase.status)) {
        throw new DomainError("case_not_analyzable", 409);
      }
      const order = state.orders.find((candidate) =>
        candidate.tenantId === principal.tenantId && candidate.id === supportCase.orderId);
      if (!order) throw new DomainError("order_not_found", 404);
      const now = this.clock().toISOString();
      supportCase.status = "analyzing";
      supportCase.updatedAt = now;
      state.idempotency[operation] = { fingerprint: requestFingerprint, state: "running" };
      audit(state, principal, "case.analysis_started", "case", supportCase.id, {}, now);
      return {
        replayed: false,
        runId: durableRunId(principal.tenantId, caseId, key),
        supportCase: structuredClone(supportCase),
        order: structuredClone(order),
      };
    });
  }

  async completeAnalysis(
    principal: Principal,
    key: string,
    caseId: string,
    result: AnalysisResult,
  ): Promise<IdempotentResponse<{ case: SupportCase }>> {
    return this.transaction((state) => {
      const operation = `${principal.tenantId}:case:analyze:${key}`;
      const requestFingerprint = fingerprint({ caseId });
      const idem = state.idempotency[operation];
      if (!idem || idem.fingerprint !== requestFingerprint || idem.state !== "running") {
        throw new DomainError("analysis_reservation_missing", 409);
      }
      const supportCase = tenantCase(state, principal.tenantId, caseId);
      if (!supportCase || supportCase.status !== "analyzing") {
        throw new DomainError("case_not_analyzing", 409);
      }
      const now = this.clock().toISOString();
      supportCase.proposal = structuredClone(result.proposal);
      supportCase.receipt = structuredClone(result.receipt);
      supportCase.status = "proposal_ready";
      supportCase.updatedAt = now;
      audit(state, principal, "case.proposal_recorded", "case", caseId, {
        disposition: result.proposal.disposition,
        claimBasis: result.claimBasis,
      }, now);
      const body = { case: structuredClone(supportCase) };
      idem.state = "complete";
      idem.statusCode = 200;
      idem.body = body;
      return { replayed: false, statusCode: 200, body };
    });
  }

  async failAnalysis(
    principal: Principal,
    key: string,
    caseId: string,
    code: string,
  ): Promise<void> {
    await this.transaction((state) => {
      const operation = `${principal.tenantId}:case:analyze:${key}`;
      const supportCase = tenantCase(state, principal.tenantId, caseId);
      if (supportCase?.status === "analyzing") {
        const now = this.clock().toISOString();
        supportCase.status = "analysis_failed";
        supportCase.updatedAt = now;
        audit(state, principal, "case.analysis_failed", "case", caseId, { code }, now);
      }
      delete state.idempotency[operation];
    });
  }

  async getCase(tenantId: string, caseId: string): Promise<SupportCase> {
    return this.read((state) => {
      const value = tenantCase(state, tenantId, caseId);
      if (!value) throw new DomainError("case_not_found", 404);
      return structuredClone(value);
    });
  }

  async auditEvents(tenantId: string, caseId?: string): Promise<AuditEvent[]> {
    return this.read((state) => structuredClone(state.audit.filter((event) =>
      event.tenantId === tenantId &&
      (caseId === undefined || event.resourceId === caseId))));
  }

  private async read<T>(reader: (state: SupportState) => T): Promise<T> {
    let output: T | undefined;
    await this.serial(async () => {
      output = reader(this.requireState());
    });
    return output as T;
  }

  private async transaction<T>(mutator: (state: SupportState) => T): Promise<T> {
    let output: T | undefined;
    await this.serial(async () => {
      const next = structuredClone(this.requireState());
      output = mutator(next);
      await this.persist(next);
      this.state = next;
    });
    return output as T;
  }

  private async serial(task: () => Promise<void>): Promise<void> {
    const previous = this.writeTail;
    let release!: () => void;
    this.writeTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      await task();
    } finally {
      release();
    }
  }

  private requireState(): SupportState {
    if (!this.state) throw new Error("support_store_not_initialized");
    return this.state;
  }

  private async persist(state: SupportState): Promise<void> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, this.path);
  }
}

function tenantCase(state: SupportState, tenantId: string, caseId: string): SupportCase | undefined {
  return state.cases.find((supportCase) =>
    supportCase.tenantId === tenantId && supportCase.id === caseId);
}

function completed<T>(
  state: SupportState,
  operation: string,
  requestFingerprint: string,
): IdempotentResponse<T> | undefined {
  const existing = state.idempotency[operation];
  if (!existing) return undefined;
  if (existing.fingerprint !== requestFingerprint) {
    throw new DomainError("idempotency_key_conflict", 409);
  }
  if (existing.state !== "complete" || existing.statusCode === undefined) {
    throw new DomainError("operation_in_progress", 409);
  }
  return {
    replayed: true,
    statusCode: existing.statusCode,
    body: structuredClone(existing.body) as T,
  };
}

function audit(
  state: SupportState,
  principal: Principal,
  action: string,
  resourceType: AuditEvent["resourceType"],
  resourceId: string,
  metadata: AuditEvent["metadata"],
  at: string,
): void {
  state.sequence += 1;
  state.audit.push({
    sequence: state.sequence,
    tenantId: principal.tenantId,
    actorId: principal.actorId,
    action,
    resourceType,
    resourceId,
    at,
    metadata,
  });
}

function durableRunId(tenantId: string, caseId: string, key: string): string {
  return `support.${fingerprint({ tenantId, caseId, key }).slice(0, 40)}`;
}
