import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createSupportAnalyzer,
} from "./agent.js";
import { loadCurrentSupportBuild } from "./build-lock.js";
import {
  validateOrder,
  type AnalysisResult,
  type SupportCase,
} from "./domain.js";

if (!process.argv.includes("--yes")) {
  throw new Error("support_comparison_confirmation_required: rerun npm run compare -- --yes; command spends at least two provider calls");
}
if (!process.env.CAVE_API_KEY) {
  throw new Error("support_comparison_cave_api_key_required");
}

const rootDir = process.cwd();
const build = await loadCurrentSupportBuild(rootDir);
const selectedModel = build.selected_plan.model;
requireProviderCredential(selectedModel);
process.env.CAVE_MODEL = selectedModel;

const orders = (JSON.parse(await readFile(resolve("data/orders.json"), "utf8")) as unknown[])
  .map(validateOrder);
const order = orders.find((candidate) => candidate.tenantId === "northwind" && candidate.id === "NW-1042");
if (!order) throw new Error("support_comparison_fixture_order_missing");
const now = new Date().toISOString();
const supportCase: SupportCase = {
  id: `case_compare_${randomUUID()}`,
  tenantId: order.tenantId,
  externalId: "comparison-damaged-delivery",
  orderId: order.id,
  subject: "Damaged delivery",
  body: "The shoulder strap arrived torn. Please review a refund for the order total.",
  status: "analyzing",
  proposal: null,
  receipt: null,
  createdAt: now,
  updatedAt: now,
};
const comparisonId = `compare-${randomUUID()}`;
const input = { supportCase, order };

process.stderr.write(JSON.stringify({
  event: "support_comparison_starting",
  warning: "real provider traffic; baseline and optimized paths each spend at least one call",
  model: selectedModel,
  buildSha256: build.build_sha256,
}) + "\n");

const off = await createSupportAnalyzer({ mode: "off", rootDir })({
  ...input,
  runId: `${comparisonId}-baseline`,
});
const on = await createSupportAnalyzer({ mode: "on", build, rootDir })({
  ...input,
  runId: `${comparisonId}-optimized`,
});

assertComparableEvidence(off, on);
const quality = {
  bothSchemaAndBusinessValid: true,
  sameDisposition: off.proposal.disposition === on.proposal.disposition,
  sameRefundAmountUsd: off.proposal.refundAmountUsd === on.proposal.refundAmountUsd,
};
if (!quality.sameDisposition || !quality.sameRefundAmountUsd) {
  throw new Error("support_comparison_quality_not_equivalent");
}

const estimatedListPriceDeltaUsd = round(
  off.execution.estimatedListPriceUsd - on.execution.estimatedListPriceUsd,
);
const report = {
  schema: "caveman.sample.support-comparison.v1",
  comparisonId,
  caseId: supportCase.id,
  model: selectedModel,
  buildSha256: build.build_sha256,
  quality,
  off: {
    proposal: off.proposal,
    execution: off.execution,
    receipt: off.receipt,
  },
  on: {
    proposal: on.proposal,
    execution: on.execution,
    receipt: on.receipt,
  },
  delta: {
    inputTokens: off.execution.inputTokens - on.execution.inputTokens,
    outputTokens: off.execution.outputTokens - on.execution.outputTokens,
    estimatedListPriceUsd: estimatedListPriceDeltaUsd,
  },
  savings: {
    claimBasis: "inferred",
    inferredSavingsUsd: Math.max(0, estimatedListPriceDeltaUsd),
    verifiedSavingsUsd: 0,
    note: "Public-catalog estimate from two local run receipts; not provider invoice or verified savings.",
  },
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

function assertComparableEvidence(offResult: AnalysisResult, onResult: AnalysisResult): void {
  if (offResult.execution.usageBasis !== "provider_reported" ||
      onResult.execution.usageBasis !== "provider_reported" ||
      offResult.execution.priceBasis !== "public_catalog" ||
      onResult.execution.priceBasis !== "public_catalog") {
    throw new Error("support_comparison_accounting_unavailable");
  }
  if (offResult.execution.mode !== "observe-only" || offResult.execution.unlocked !== true) {
    throw new Error("support_comparison_baseline_invalid");
  }
  if (onResult.execution.mode !== "optimized" || onResult.execution.unlocked !== false ||
      onResult.execution.transformIDs.length === 0 ||
      onResult.execution.recoveryResolved !== true) {
    throw new Error("support_comparison_optimized_evidence_invalid");
  }
}

function requireProviderCredential(model: string): void {
  const provider = model.split("/", 1)[0];
  const present = provider === "anthropic"
    ? Boolean(process.env.ANTHROPIC_API_KEY)
    : provider === "openai"
      ? Boolean(process.env.OPENAI_API_KEY)
      : provider === "google"
        ? Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)
        : false;
  if (!present) throw new Error(`support_comparison_provider_credential_required:${provider}`);
}

function round(value: number): number {
  return Math.round(value * 1_000_000_000) / 1_000_000_000;
}
