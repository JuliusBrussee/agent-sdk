import type { AdapterLifecycleEvent } from "@caveman-ai/adapter-kit";
import {
  createVercelAISDKAdapter,
  manifest,
  type VercelModelRequest,
  type VercelModelResponse,
} from "@caveman-ai/adapter-vercel-ai-sdk";
import { createModelBoundary } from "@caveman-ai/agent/model-boundary";
import type { ModelUsage } from "@caveman-ai/agent/model-usage";
import { ToolLoopAgent, wrapLanguageModel } from "ai";

export type WrappableLanguageModel = Parameters<typeof wrapLanguageModel>[0]["model"];

export interface ProcurementRequest {
  requestId: string;
  vendorName: string;
  annualSpendUsd: number;
  dataClasses: string[];
  controlEvidence: string[];
}

export interface ProcurementRecommendation {
  disposition: "proceed" | "conditional" | "decline";
  summary: string;
  conditions: string[];
  evidence: string[];
  executionStatus: "not_executed";
}

export interface ProcurementReviewResult {
  recommendation: ProcurementRecommendation;
  integration: {
    adapterId: string;
    upstreamVersion: string;
    lifecycle: readonly AdapterLifecycleEvent[];
    usage: readonly ModelUsage[];
  };
}

/**
 * One native Vercel loop with Caveman request/lifecycle/usage seams. No second
 * loop, proxy, action executor, approval queue, or permission layer exists.
 */
export async function reviewProcurementRequest(options: {
  request: ProcurementRequest;
  model: WrappableLanguageModel;
  signal?: AbortSignal;
}): Promise<ProcurementReviewResult> {
  const request = validateRequest(options.request);
  const lifecycle: AdapterLifecycleEvent[] = [];
  const usage: ModelUsage[] = [];
  const boundary = createModelBoundary<VercelModelRequest, VercelModelResponse>([{
    id: "procurement-deterministic-request",
    prepare({ request: modelRequest }) {
      return { ...modelRequest, temperature: 0 };
    },
  }]);
  const adapter = createVercelAISDKAdapter({
    modelBoundary: boundary,
    onLifecycleEvent(event) {
      lifecycle.push(event);
    },
    onModelUsage(value) {
      usage.push(value);
    },
  });
  const agent = new ToolLoopAgent({
    model: wrapLanguageModel({ model: options.model, middleware: adapter.middleware }),
    instructions: [
      "Return one evidence-backed procurement recommendation as JSON.",
      "This workflow never executes procurement actions.",
      "Evidence array may contain only exact supplied control-evidence strings.",
    ].join("\n"),
    ...adapter.composeAgentCallbacks(),
  });
  const response = await agent.generate({
    prompt: JSON.stringify({
      request,
      requiredOutput: {
        disposition: "proceed | conditional | decline",
        summary: "string",
        conditions: ["string"],
        evidence: ["exact supplied control evidence"],
        executionStatus: "not_executed",
      },
    }),
    ...(options.signal === undefined ? {} : { abortSignal: options.signal }),
  });
  const recommendation = validateRecommendation(JSON.parse(response.text), request);
  return Object.freeze({
    recommendation,
    integration: Object.freeze({
      adapterId: manifest.id,
      upstreamVersion: manifest.upstream.version,
      lifecycle: Object.freeze([...lifecycle]),
      usage: Object.freeze([...usage]),
    }),
  });
}

export const adapterManifest = manifest;

function validateRequest(value: ProcurementRequest): ProcurementRequest {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.requestId) ||
      typeof value.vendorName !== "string" || value.vendorName.trim() === "" ||
      value.vendorName.length > 160 || !Number.isFinite(value.annualSpendUsd) ||
      value.annualSpendUsd < 0 || value.annualSpendUsd > 1_000_000_000 ||
      !stringArray(value.dataClasses, 16, 120) ||
      !stringArray(value.controlEvidence, 64, 300)) {
    throw new Error("procurement_request_invalid");
  }
  return structuredClone(value);
}

function validateRecommendation(
  value: unknown,
  request: ProcurementRequest,
): ProcurementRecommendation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("procurement_recommendation_invalid");
  }
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(",") !==
        "conditions,disposition,evidence,executionStatus,summary" ||
      !["proceed", "conditional", "decline"].includes(String(row.disposition)) ||
      typeof row.summary !== "string" || row.summary.trim() === "" || row.summary.length > 1_500 ||
      !stringArray(row.conditions, 16, 300) || !stringArray(row.evidence, 32, 300) ||
      row.executionStatus !== "not_executed") {
    throw new Error("procurement_recommendation_invalid");
  }
  const suppliedEvidence = new Set(request.controlEvidence);
  if ((row.evidence as string[]).some((entry) => !suppliedEvidence.has(entry))) {
    throw new Error("procurement_evidence_not_supplied");
  }
  return Object.freeze(structuredClone(row) as unknown as ProcurementRecommendation);
}

function stringArray(value: unknown, maxItems: number, maxLength: number): value is string[] {
  return Array.isArray(value) && value.length <= maxItems &&
    value.every((entry) => typeof entry === "string" && entry.trim() !== "" && entry.length <= maxLength);
}
