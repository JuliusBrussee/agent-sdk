import { createHash } from "node:crypto";

export interface Principal { tenantId: string; actorId: string }
export interface Asset {
  tenantId: string;
  id: string;
  criticality: "low" | "medium" | "high" | "critical";
  owner: string;
  controls: string[];
}
export interface AlertInput {
  externalId: string;
  assetId: string;
  title: string;
  detail: string;
  indicators: string[];
}
export interface TriageProposal {
  severity: "P1" | "P2" | "P3" | "P4";
  summary: string;
  evidence: string[];
  containmentActions: string[];
  notificationRequired: boolean;
  escalationReason: string | null;
}
export interface Incident {
  id: string;
  tenantId: string;
  externalId: string;
  assetId: string;
  title: string;
  detail: string;
  indicators: string[];
  status: "received" | "triaging" | "proposal_ready" | "triage_failed";
  proposal: TriageProposal | null;
  receipt: unknown | null;
  createdAt: string;
  updatedAt: string;
}
export interface AuditEvent {
  sequence: number;
  tenantId: string;
  actorId: string;
  action: string;
  resourceType: "incident";
  resourceId: string;
  at: string;
  metadata: Record<string, string | number | boolean | null>;
}
export interface SecurityState {
  schemaVersion: 2;
  sequence: number;
  assets: Asset[];
  incidents: Incident[];
  audit: AuditEvent[];
  idempotency: Record<string, { fingerprint: string; state: "running" | "complete"; statusCode?: number; body?: unknown }>;
}
export interface TriageInput {
  runId: string;
  incident: Incident;
  asset: Asset;
  signal?: AbortSignal;
}
export interface TriageResult {
  proposal: TriageProposal;
  receipt: unknown;
  claimBasis: "inferred";
  streamEventTypes: string[];
}
export type TriageAnalyzer = (input: TriageInput) => Promise<TriageResult>;

export class DomainError extends Error {
  constructor(readonly code: string, readonly statusCode: number) { super(code); }
}

export function validateAsset(value: unknown): Asset {
  const row = record(value, "asset_invalid");
  return {
    tenantId: identifier(row.tenantId),
    id: identifier(row.id),
    criticality: oneOf(row.criticality, ["low", "medium", "high", "critical"] as const, "asset_criticality_invalid"),
    owner: identifier(row.owner),
    controls: stringArray(row.controls, "asset_controls_invalid", 16, 80),
  };
}

export function validateAlertInput(value: unknown): AlertInput {
  const row = exact(value, ["externalId", "assetId", "title", "detail", "indicators"], "alert_input_invalid");
  return {
    externalId: bounded(row.externalId, "alert_external_id_invalid", 1, 96),
    assetId: identifier(row.assetId),
    title: bounded(row.title, "alert_title_invalid", 1, 240),
    detail: bounded(row.detail, "alert_detail_invalid", 1, 12_000),
    indicators: stringArray(row.indicators, "alert_indicators_invalid", 32, 240),
  };
}

export function validateProposal(value: unknown, asset: Asset): TriageProposal {
  const row = exact(value, [
    "severity", "summary", "evidence", "containmentActions", "notificationRequired", "escalationReason",
  ], "triage_proposal_invalid");
  const evidence = stringArray(row.evidence, "triage_evidence_invalid", 24, 240);
  if (evidence.length === 0) throw new DomainError("triage_evidence_required", 422);
  const containmentActions = stringArray(row.containmentActions, "triage_actions_invalid", 8, 240);
  if (containmentActions.length === 0) throw new DomainError("triage_actions_required", 422);
  if (typeof row.notificationRequired !== "boolean") throw new DomainError("triage_notification_invalid", 422);
  const escalationReason = row.escalationReason === null
    ? null : bounded(row.escalationReason, "triage_escalation_invalid", 1, 600);
  const severity = oneOf(row.severity, ["P1", "P2", "P3", "P4"] as const, "triage_severity_invalid");
  if (asset.criticality === "critical" && severity === "P4") {
    throw new DomainError("triage_severity_below_asset_floor", 422);
  }
  if ((severity === "P1" || severity === "P2") && escalationReason === null) {
    throw new DomainError("triage_escalation_required", 422);
  }
  return {
    severity,
    summary: bounded(row.summary, "triage_summary_invalid", 1, 1_500),
    evidence,
    containmentActions,
    notificationRequired: row.notificationRequired,
    escalationReason,
  };
}

export function emptyState(assets: Asset[]): SecurityState {
  return { schemaVersion: 2, sequence: 0, assets, incidents: [], audit: [], idempotency: {} };
}
export function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new DomainError("identifier_invalid", 400);
  }
  return value;
}
export function idempotencyKey(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)) {
    throw new DomainError("idempotency_key_invalid", 400);
  }
  return value;
}
export function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function exact(value: unknown, keys: string[], code: string): Record<string, unknown> {
  const row = record(value, code);
  if (Object.keys(row).sort().join(",") !== [...keys].sort().join(",")) throw new DomainError(code, 400);
  return row;
}
function record(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DomainError(code, 400);
  return value as Record<string, unknown>;
}
function bounded(value: unknown, code: string, min: number, max: number): string {
  if (typeof value !== "string" || value.trim().length < min || value.length > max) throw new DomainError(code, 400);
  return value;
}
function stringArray(value: unknown, code: string, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems || value.some((item) => typeof item !== "string" || item.length < 1 || item.length > maxLength)) {
    throw new DomainError(code, 400);
  }
  return [...new Set(value)];
}
function oneOf<const T extends readonly string[]>(value: unknown, allowed: T, code: string): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) throw new DomainError(code, 400);
  return value as T[number];
}
