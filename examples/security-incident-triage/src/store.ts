import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  DomainError,
  emptyState,
  fingerprint,
  type AlertInput,
  type Asset,
  type Incident,
  type Principal,
  type SecurityState,
  type TriageResult,
} from "./domain.js";

export class FileSecurityStore {
  private state?: SecurityState;
  private writeTail = Promise.resolve();
  constructor(private readonly path: string, private readonly clock = () => new Date()) {}

  async initialize(assets: Asset[]): Promise<void> {
    await this.serial(async () => {
      try {
        const parsed = JSON.parse(await readFile(this.path, "utf8")) as SecurityState;
        if (parsed.schemaVersion !== 2 || !Array.isArray(parsed.assets) ||
            !Array.isArray(parsed.incidents) || !Array.isArray(parsed.audit) ||
            parsed.idempotency === null || typeof parsed.idempotency !== "object") {
          throw new Error("security_state_schema_unsupported");
        }
        this.state = parsed;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        this.state = emptyState(assets);
        await this.persist(this.state);
      }
    });
  }

  async readiness() { return this.read((state) => ({ status: "ready", schemaVersion: state.schemaVersion })); }

  async createIncident(principal: Principal, key: string, input: AlertInput) {
    return this.transaction((state) => {
      const operation = `${principal.tenantId}:incident:create:${key}`;
      const requestHash = fingerprint(input);
      const replay = completed<Incident>(state, operation, requestHash);
      if (replay) return replay;
      if (!state.assets.some((asset) => asset.tenantId === principal.tenantId && asset.id === input.assetId)) {
        throw new DomainError("asset_not_found", 404);
      }
      const now = this.clock().toISOString();
      const incident: Incident = {
        id: `incident_${randomUUID()}`,
        tenantId: principal.tenantId,
        ...input,
        status: "received",
        proposal: null,
        receipt: null,
        createdAt: now,
        updatedAt: now,
      };
      state.incidents.push(incident);
      audit(state, principal, "incident.created", "incident", incident.id, { externalId: input.externalId }, now);
      state.idempotency[operation] = { fingerprint: requestHash, state: "complete", statusCode: 201, body: incident };
      return { replayed: false, statusCode: 201, body: structuredClone(incident) };
    });
  }

  async reserveTriage(principal: Principal, key: string, incidentId: string) {
    return this.transaction((state) => {
      const operation = `${principal.tenantId}:incident:triage:${key}`;
      const requestHash = fingerprint({ incidentId });
      const replay = completed<unknown>(state, operation, requestHash);
      if (replay) return { ...replay, incident: undefined, asset: undefined, runId: undefined };
      const incident = tenantIncident(state, principal.tenantId, incidentId);
      if (!incident) throw new DomainError("incident_not_found", 404);
      if (incident.status !== "received" && incident.status !== "triage_failed") {
        throw new DomainError("incident_not_triageable", 409);
      }
      const asset = state.assets.find((candidate) => candidate.tenantId === principal.tenantId && candidate.id === incident.assetId);
      if (!asset) throw new DomainError("asset_not_found", 404);
      const now = this.clock().toISOString();
      incident.status = "triaging";
      incident.updatedAt = now;
      state.idempotency[operation] = { fingerprint: requestHash, state: "running" };
      audit(state, principal, "incident.triage_started", "incident", incident.id, {}, now);
      return {
        replayed: false,
        statusCode: undefined,
        body: undefined,
        incident: structuredClone(incident),
        asset: structuredClone(asset),
        runId: durableRunId(principal.tenantId, incidentId, key),
      };
    });
  }

  async completeTriage(principal: Principal, key: string, incidentId: string, result: TriageResult) {
    return this.transaction((state) => {
      const operation = `${principal.tenantId}:incident:triage:${key}`;
      const idem = state.idempotency[operation];
      if (!idem || idem.state !== "running" || idem.fingerprint !== fingerprint({ incidentId })) {
        throw new DomainError("triage_reservation_missing", 409);
      }
      const incident = tenantIncident(state, principal.tenantId, incidentId);
      if (!incident || incident.status !== "triaging") throw new DomainError("incident_not_triaging", 409);
      const now = this.clock().toISOString();
      incident.status = "proposal_ready";
      incident.proposal = structuredClone(result.proposal);
      incident.receipt = structuredClone({ ...result.receipt as object, streamEventTypes: result.streamEventTypes });
      incident.updatedAt = now;
      audit(state, principal, "incident.proposal_recorded", "incident", incidentId, {
        severity: result.proposal.severity,
        claimBasis: result.claimBasis,
        actionCount: result.proposal.containmentActions.length,
      }, now);
      const body = { incident: structuredClone(incident) };
      Object.assign(idem, { state: "complete", statusCode: 200, body });
      return { replayed: false, statusCode: 200, body };
    });
  }

  async failTriage(principal: Principal, key: string, incidentId: string, code: string): Promise<void> {
    await this.transaction((state) => {
      const incident = tenantIncident(state, principal.tenantId, incidentId);
      if (incident?.status === "triaging") {
        const now = this.clock().toISOString();
        incident.status = "triage_failed";
        incident.updatedAt = now;
        audit(state, principal, "incident.triage_failed", "incident", incidentId, { code }, now);
      }
      delete state.idempotency[`${principal.tenantId}:incident:triage:${key}`];
    });
  }

  async getIncident(tenantId: string, id: string) {
    return this.read((state) => {
      const incident = tenantIncident(state, tenantId, id);
      if (!incident) throw new DomainError("incident_not_found", 404);
      return structuredClone(incident);
    });
  }
  async auditEvents(tenantId: string) {
    return this.read((state) => structuredClone(state.audit.filter((event) => event.tenantId === tenantId)));
  }

  private async read<T>(fn: (state: SecurityState) => T): Promise<T> {
    let value!: T;
    await this.serial(async () => { value = fn(this.requireState()); });
    return value;
  }
  private async transaction<T>(fn: (state: SecurityState) => T): Promise<T> {
    let value!: T;
    await this.serial(async () => {
      const next = structuredClone(this.requireState());
      value = fn(next);
      await this.persist(next);
      this.state = next;
    });
    return value;
  }
  private async serial(fn: () => Promise<void>) {
    const previous = this.writeTail;
    let release!: () => void;
    this.writeTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { await fn(); } finally { release(); }
  }
  private requireState() { if (!this.state) throw new Error("security_store_not_initialized"); return this.state; }
  private async persist(state: SecurityState) {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, this.path);
  }
}

function tenantIncident(state: SecurityState, tenantId: string, id: string) {
  return state.incidents.find((incident) => incident.tenantId === tenantId && incident.id === id);
}
function completed<T>(state: SecurityState, operation: string, requestHash: string) {
  const item = state.idempotency[operation];
  if (!item) return undefined;
  if (item.fingerprint !== requestHash) throw new DomainError("idempotency_key_conflict", 409);
  if (item.state !== "complete" || item.statusCode === undefined) throw new DomainError("operation_in_progress", 409);
  return { replayed: true, statusCode: item.statusCode, body: structuredClone(item.body) as T };
}
function audit(
  state: SecurityState,
  principal: Principal,
  action: string,
  resourceType: "incident",
  resourceId: string,
  metadata: AuditEventMetadata,
  at: string,
) {
  state.sequence += 1;
  state.audit.push({ sequence: state.sequence, tenantId: principal.tenantId, actorId: principal.actorId, action, resourceType, resourceId, at, metadata });
}
type AuditEventMetadata = Record<string, string | number | boolean | null>;
function durableRunId(tenantId: string, incidentId: string, key: string) {
  return `security-${fingerprint({ tenantId, incidentId, key }).slice(0, 48)}`;
}
