import { createHash } from "node:crypto";

export const SUPPORT_STATE_SCHEMA_VERSION = 2 as const;

export interface Principal {
  tenantId: string;
  actorId: string;
}

export interface Order {
  tenantId: string;
  id: string;
  customerId: string;
  region: "EU" | "US";
  status: "processing" | "in_transit" | "delivered" | "cancelled";
  totalUsd: number;
  deliveredOn: string | null;
}

export interface CaseInput {
  externalId: string;
  orderId: string;
  subject: string;
  body: string;
}

export type CaseStatus =
  | "received"
  | "analyzing"
  | "proposal_ready"
  | "analysis_failed";

export type ProposalDisposition = "respond" | "refund_review" | "escalate";

export interface SupportProposal {
  disposition: ProposalDisposition;
  summary: string;
  replyDraft: string;
  confidence: "low" | "medium" | "high";
  policyEvidence: string[];
  refundAmountUsd: number | null;
  escalationReason: string | null;
}

export interface SupportCase {
  id: string;
  tenantId: string;
  externalId: string;
  orderId: string;
  subject: string;
  body: string;
  status: CaseStatus;
  proposal: SupportProposal | null;
  receipt: unknown | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuditEvent {
  sequence: number;
  tenantId: string;
  actorId: string;
  action: string;
  resourceType: "case";
  resourceId: string;
  at: string;
  metadata: Readonly<Record<string, string | number | boolean | null>>;
}

export interface IdempotencyRecord {
  fingerprint: string;
  state: "running" | "complete";
  statusCode?: number;
  body?: unknown;
}

export interface SupportState {
  schemaVersion: typeof SUPPORT_STATE_SCHEMA_VERSION;
  sequence: number;
  cases: SupportCase[];
  orders: Order[];
  audit: AuditEvent[];
  idempotency: Record<string, IdempotencyRecord>;
}

export interface AnalysisResult {
  proposal: SupportProposal;
  receipt: unknown;
  claimBasis: "inferred";
  execution: {
    mode: "optimized" | "observe-only";
    unlocked: boolean;
    usageBasis: "provider_reported" | "unavailable";
    priceBasis: "public_catalog" | "unpriced";
    inputTokens: number;
    outputTokens: number;
    estimatedListPriceUsd: number;
    evaluatedTransformIDs: readonly string[];
    transformIDs: readonly string[];
    transformFailures: readonly string[];
    recoveryResolved: boolean;
  };
}

export interface AnalysisInput {
  runId: string;
  supportCase: SupportCase;
  order: Order;
}

export type SupportAnalyzer = (input: AnalysisInput) => Promise<AnalysisResult>;

export class DomainError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
  ) {
    super(code);
  }
}

export function emptySupportState(orders: readonly Order[]): SupportState {
  return {
    schemaVersion: SUPPORT_STATE_SCHEMA_VERSION,
    sequence: 0,
    cases: [],
    orders: orders.map((order) => validateOrder(order)),
    audit: [],
    idempotency: {},
  };
}

export function validateOrder(value: unknown): Order {
  const row = record(value, "order_invalid");
  const tenantId = identifier(row.tenantId, "order_tenant_invalid");
  const id = boundedString(row.id, "order_id_invalid", 1, 64);
  const customerId = boundedString(row.customerId, "order_customer_invalid", 1, 96);
  const region = oneOf(row.region, ["EU", "US"] as const, "order_region_invalid");
  const status = oneOf(
    row.status,
    ["processing", "in_transit", "delivered", "cancelled"] as const,
    "order_status_invalid",
  );
  const totalUsd = money(row.totalUsd, "order_total_invalid");
  const deliveredOn = row.deliveredOn === null
    ? null
    : boundedString(row.deliveredOn, "order_delivery_date_invalid", 10, 10);
  return { tenantId, id, customerId, region, status, totalUsd, deliveredOn };
}

export function validateCaseInput(value: unknown): CaseInput {
  const row = exactRecord(value, ["externalId", "orderId", "subject", "body"], "case_input_invalid");
  return {
    externalId: boundedString(row.externalId, "case_external_id_invalid", 1, 96),
    orderId: boundedString(row.orderId, "case_order_id_invalid", 1, 64),
    subject: boundedString(row.subject, "case_subject_invalid", 1, 240),
    body: boundedString(row.body, "case_body_invalid", 1, 12_000),
  };
}

export function validateProposal(value: unknown, order: Order): SupportProposal {
  const row = exactRecord(value, [
    "disposition",
    "summary",
    "replyDraft",
    "confidence",
    "policyEvidence",
    "refundAmountUsd",
    "escalationReason",
  ], "proposal_invalid");
  const disposition = oneOf(
    row.disposition,
    ["respond", "refund_review", "escalate"] as const,
    "proposal_disposition_invalid",
  );
  const policyEvidence = stringArray(row.policyEvidence, "proposal_evidence_invalid", 8, 160);
  if (policyEvidence.length === 0) throw new DomainError("proposal_evidence_required", 422);
  const refundAmountUsd = row.refundAmountUsd === null
    ? null
    : money(row.refundAmountUsd, "proposal_refund_invalid");
  const escalationReason = row.escalationReason === null
    ? null
    : boundedString(row.escalationReason, "proposal_escalation_invalid", 1, 600);
  if (disposition === "refund_review" &&
      (refundAmountUsd === null || refundAmountUsd <= 0 || refundAmountUsd > order.totalUsd)) {
    throw new DomainError("proposal_refund_out_of_bounds", 422);
  }
  if (disposition !== "refund_review" && refundAmountUsd !== null) {
    throw new DomainError("proposal_refund_unexpected", 422);
  }
  if (disposition === "escalate" && escalationReason === null) {
    throw new DomainError("proposal_escalation_reason_required", 422);
  }
  if (disposition !== "escalate" && escalationReason !== null) {
    throw new DomainError("proposal_escalation_reason_unexpected", 422);
  }
  return {
    disposition,
    summary: boundedString(row.summary, "proposal_summary_invalid", 1, 1_000),
    replyDraft: boundedString(row.replyDraft, "proposal_reply_invalid", 1, 6_000),
    confidence: oneOf(
      row.confidence,
      ["low", "medium", "high"] as const,
      "proposal_confidence_invalid",
    ),
    policyEvidence,
    refundAmountUsd,
    escalationReason,
  };
}

export function idempotencyKey(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)) {
    throw new DomainError("idempotency_key_invalid", 400);
  }
  return value;
}

export function identifier(value: unknown, code = "identifier_invalid"): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_-]{0,95}$/.test(value)) {
    throw new DomainError(code, 400);
  }
  return value;
}

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJSON(value)).digest("hex");
}

function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJSON(row[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function exactRecord(value: unknown, keys: readonly string[], code: string): Record<string, unknown> {
  const row = record(value, code);
  const actual = Object.keys(row).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new DomainError(code, 400);
  }
  return row;
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError(code, 400);
  }
  return value as Record<string, unknown>;
}

function boundedString(
  value: unknown,
  code: string,
  minimum: number,
  maximum: number,
): string {
  if (typeof value !== "string" || value.trim().length < minimum || value.length > maximum) {
    throw new DomainError(code, 400);
  }
  return value;
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  choices: T,
  code: string,
): T[number] {
  if (typeof value !== "string" || !choices.includes(value)) {
    throw new DomainError(code, 400);
  }
  return value as T[number];
}

function money(value: unknown, code: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 ||
      Math.round(value * 100) !== value * 100 || value > 1_000_000) {
    throw new DomainError(code, 400);
  }
  return value;
}

function stringArray(value: unknown, code: string, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems ||
      value.some((item) => typeof item !== "string" || item.trim() === "" || item.length > maxLength)) {
    throw new DomainError(code, 400);
  }
  return [...value];
}
