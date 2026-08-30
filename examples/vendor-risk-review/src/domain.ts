import { createHash } from "node:crypto";

export interface Principal { tenantId: string; actorId: string }
export interface Evidence { id: string; kind: string; summary: string }
export interface Vendor { tenantId: string; id: string; name: string; evidence: Evidence[] }
export interface ReviewInput { externalId: string; vendorId: string; questionnaire: Record<string, string> }
export interface ControlAssessment { controlId: "IAM-1" | "ENC-1" | "IR-1" | "SUB-1"; status: "met" | "partial" | "gap"; evidenceRefs: string[]; rationale: string }
export interface RiskProposal {
  riskTier: "low" | "medium" | "high" | "critical";
  riskDisposition: "favorable" | "conditions_required" | "unfavorable";
  summary: string;
  controls: ControlAssessment[];
  conditions: string[];
}
export interface Review {
  id: string; tenantId: string; externalId: string; vendorId: string; questionnaire: Record<string, string>;
  status: "received" | "reviewing" | "proposal_ready" | "review_failed";
  proposal: RiskProposal | null; receipt: unknown | null; createdAt: string; updatedAt: string;
}
export interface AuditEvent { sequence: number; tenantId: string; actorId: string; action: string; resourceType: "review"; resourceId: string; at: string; metadata: Record<string, string | number | boolean | null> }
export interface VendorState { schemaVersion: 2; sequence: number; vendors: Vendor[]; reviews: Review[]; audit: AuditEvent[]; idempotency: Record<string, { fingerprint: string; state: "running" | "complete"; statusCode?: number; body?: unknown }> }
export interface AnalyzerInput { runId: string; review: Review; vendor: Vendor }
export interface AnalyzerResult { proposal: RiskProposal; receipt: unknown; claimBasis: "inferred" }
export type VendorAnalyzer = (input: AnalyzerInput) => Promise<AnalyzerResult>;
export class DomainError extends Error { constructor(readonly code: string, readonly statusCode: number) { super(code); } }

export function validateVendor(value: unknown): Vendor {
  const row = record(value, "vendor_invalid");
  if (!Array.isArray(row.evidence) || row.evidence.length === 0 || row.evidence.length > 32) throw new DomainError("vendor_evidence_invalid", 400);
  return { tenantId: identifier(row.tenantId), id: identifier(row.id), name: bounded(row.name, "vendor_name_invalid", 1, 160), evidence: row.evidence.map((item) => { const evidence = record(item, "vendor_evidence_invalid"); return { id: identifier(evidence.id), kind: identifier(evidence.kind), summary: bounded(evidence.summary, "vendor_evidence_invalid", 1, 2_000) }; }) };
}
export function validateReviewInput(value: unknown): ReviewInput {
  const row = exact(value, ["externalId", "vendorId", "questionnaire"], "review_input_invalid");
  const questionnaire = record(row.questionnaire, "questionnaire_invalid");
  const entries = Object.entries(questionnaire);
  if (entries.length < 1 || entries.length > 64 || entries.some(([key, answer]) => !/^[A-Z0-9_-]{2,32}$/.test(key) || typeof answer !== "string" || answer.length < 1 || answer.length > 4_000)) throw new DomainError("questionnaire_invalid", 400);
  return { externalId: bounded(row.externalId, "review_external_id_invalid", 1, 96), vendorId: identifier(row.vendorId), questionnaire: Object.fromEntries(entries) as Record<string, string> };
}
export function validateProposal(value: unknown, vendor: Vendor): RiskProposal {
  const row = exact(value, ["riskTier", "riskDisposition", "summary", "controls", "conditions"], "risk_proposal_invalid");
  if (!Array.isArray(row.controls) || row.controls.length !== 4) throw new DomainError("risk_controls_invalid", 422);
  const allowedEvidence = new Set(vendor.evidence.map((item) => item.id));
  const controls = row.controls.map((value): ControlAssessment => {
    const item = exact(value, ["controlId", "status", "evidenceRefs", "rationale"], "risk_control_invalid");
    const refs = strings(item.evidenceRefs, "risk_evidence_refs_invalid", 16, 128);
    if (refs.some((ref) => !allowedEvidence.has(ref))) throw new DomainError("risk_evidence_ref_unknown", 422);
    return { controlId: oneOf(item.controlId, ["IAM-1", "ENC-1", "IR-1", "SUB-1"] as const, "risk_control_id_invalid"), status: oneOf(item.status, ["met", "partial", "gap"] as const, "risk_control_status_invalid"), evidenceRefs: refs, rationale: bounded(item.rationale, "risk_rationale_invalid", 1, 800) };
  });
  if (new Set(controls.map((item) => item.controlId)).size !== 4) throw new DomainError("risk_controls_incomplete", 422);
  const conditions = strings(row.conditions, "risk_conditions_invalid", 16, 500);
  const riskDisposition = oneOf(row.riskDisposition, ["favorable", "conditions_required", "unfavorable"] as const, "risk_disposition_invalid");
  const riskTier = oneOf(row.riskTier, ["low", "medium", "high", "critical"] as const, "risk_tier_invalid");
  if (riskDisposition === "conditions_required" && conditions.length === 0) throw new DomainError("risk_conditions_required", 422);
  if (riskDisposition === "favorable" && controls.some((item) => item.status === "gap")) throw new DomainError("risk_favorable_with_gap", 422);
  if (riskTier === "critical" && riskDisposition === "favorable") throw new DomainError("risk_critical_favorable_invalid", 422);
  return { riskTier, riskDisposition, summary: bounded(row.summary, "risk_summary_invalid", 1, 1_500), controls, conditions };
}
export function emptyState(vendors: Vendor[]): VendorState { return { schemaVersion: 2, sequence: 0, vendors, reviews: [], audit: [], idempotency: {} }; }
export function identifier(value: unknown): string { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new DomainError("identifier_invalid", 400); return value; }
export function idempotencyKey(value: unknown): string { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)) throw new DomainError("idempotency_key_invalid", 400); return value; }
export function fingerprint(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") { const row = value as Record<string, unknown>; return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(",")}}`; } return JSON.stringify(value); }
function exact(value: unknown, keys: string[], code: string) { const row = record(value, code); if (Object.keys(row).sort().join(",") !== [...keys].sort().join(",")) throw new DomainError(code, 400); return row; }
function record(value: unknown, code: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new DomainError(code, 400); return value as Record<string, unknown>; }
function bounded(value: unknown, code: string, min: number, max: number): string { if (typeof value !== "string" || value.trim().length < min || value.length > max) throw new DomainError(code, 400); return value; }
function strings(value: unknown, code: string, maxItems: number, maxLength: number): string[] { if (!Array.isArray(value) || value.length > maxItems || value.some((item) => typeof item !== "string" || item.length < 1 || item.length > maxLength)) throw new DomainError(code, 400); return [...new Set(value)]; }
function oneOf<const T extends readonly string[]>(value: unknown, allowed: T, code: string): T[number] { if (typeof value !== "string" || !allowed.includes(value)) throw new DomainError(code, 400); return value as T[number]; }
