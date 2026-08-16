import { sha256, stableStringify } from "./context-ir.js";
import { catalogCost, catalogPriceFingerprint } from "./catalog.js";
import type { ContextKind, ToolEffect } from "./primitives.js";

export const TRAJECTORY_IR_SCHEMA_VERSION = 1 as const;

export type WorkloadSplit = "profile" | "development" | "holdout";
export type TrajectorySource = "caveman_run_result" | "otel_span" | "openinference_span";

export interface NormalizedToolActivity {
  readonly tool_sha256: string;
  readonly effect: ToolEffect;
  readonly calls: number;
  readonly errors: number;
}

export interface NormalizedTrajectory {
  readonly schema_version: typeof TRAJECTORY_IR_SCHEMA_VERSION;
  readonly trajectory_sha256: string;
  readonly case_sha256: string;
  readonly lineage_sha256: string;
  readonly input_sha256: string;
  readonly run_sha256: string;
  readonly agent_sha256: string;
  readonly source: TrajectorySource;
  readonly split: WorkloadSplit;
  readonly provider: string;
  readonly model: string;
  readonly terminal: boolean;
  readonly outcome: "complete" | "stopped" | "error";
  readonly usage_basis: "provider_reported" | "unavailable";
  readonly price_basis: "public_catalog" | "unpriced";
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_tokens: number;
  readonly cache_write_tokens: number;
  readonly reasoning_tokens: number;
  readonly cost_usd: number;
  readonly latency_ms: number;
  readonly model_calls: number;
  readonly context_bill: Readonly<Partial<Record<ContextKind, number>>>;
  readonly tools: readonly NormalizedToolActivity[];
  readonly evaluated_transform_ids: readonly string[];
  readonly applied_transform_ids: readonly string[];
  readonly recovery_resolved: boolean;
}

export interface NormalizeTrajectoryOptions {
  /** Stable workload-case identity. Only its SHA-256 digest is retained. */
  readonly caseId: string;
  /** Family/lineage identity shared by derived variants. Only its digest is retained. */
  readonly lineageId: string;
  /** SHA-256 of canonical task input bytes. Raw input is never retained. */
  readonly inputSha256: string;
  /** Expected target-agent digest. Imported traces must bind to it. */
  readonly agentSha256?: string;
  readonly split: WorkloadSplit;
  /** Tool declarations keyed by runtime name. Missing tools become `external`. */
  readonly toolEffects?: Readonly<Record<string, ToolEffect>>;
  /** Compiler-owned boundaries for a live Caveman run. Scheduled imported
   * traces without both times remain unpriced. */
  readonly accountingStartedAt?: Date;
  readonly accountingFinishedAt?: Date;
}

const SPLITS: readonly WorkloadSplit[] = ["profile", "development", "holdout"];
const EFFECTS: readonly ToolEffect[] = ["read", "idempotent", "write", "external"];
const CONTEXT_KINDS: readonly ContextKind[] = [
  "instruction", "user_intent", "tool_schema", "skill", "memory", "history",
  "tool_result", "artifact", "error", "output_contract",
];
const HEX_64 = /^[0-9a-f]{64}$/;
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,191}$/;
const TRANSFORM_ID = /^caveman\.[a-z0-9.-]{1,120}$/;
const NORMALIZED_KEYS = [
  "schema_version", "trajectory_sha256", "case_sha256", "lineage_sha256", "input_sha256", "run_sha256", "agent_sha256",
  "source", "split", "provider", "model", "terminal", "outcome", "usage_basis",
  "price_basis", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens",
  "reasoning_tokens", "cost_usd", "latency_ms", "model_calls", "context_bill", "tools",
  "evaluated_transform_ids", "applied_transform_ids", "recovery_resolved",
] as const;

/**
 * Project a Caveman result or a content-blind OTel/OpenInference span into the
 * compiler's normalized trajectory IR. Prompt, message, result and output
 * bodies are never copied into the returned object or its digest.
 */
export function normalizeTrajectory(
  value: unknown,
  options: NormalizeTrajectoryOptions,
): NormalizedTrajectory {
  validateOptions(options);
  if (!isRecord(value)) throw new Error("cave_trajectory_invalid:record");
  if (looksLikeCavemanRunResult(value)) {
    assertNoRawContent(value, true);
    return finalizeTrajectory(projectCavemanResult(value, options));
  }
  assertNoRawContent(value, false);
  return finalizeTrajectory(projectSpan(value, options));
}

/** Strictly parse already-normalized, content-blind trajectory data. */
export function parseNormalizedTrajectory(value: unknown): NormalizedTrajectory {
  if (!isRecord(value) || !exactKeys(value, NORMALIZED_KEYS)) {
    throw new Error("cave_trajectory_invalid:shape");
  }
  const trajectory = value as unknown as NormalizedTrajectory;
  validateNormalized(trajectory);
  const { trajectory_sha256: _digest, ...payload } = trajectory;
  if (sha256(stableStringify(payload)) !== trajectory.trajectory_sha256) {
    throw new Error("cave_trajectory_invalid:digest");
  }
  return deepFreeze(structuredClone(trajectory));
}

function projectCavemanResult(
  result: Record<string, unknown>,
  options: NormalizeTrajectoryOptions,
): Omit<NormalizedTrajectory, "trajectory_sha256"> {
  const runId = boundedString(result.runId, "run_id", 512);
  const agentId = boundedString(result.agentId, "agent_id", 256);
  const derivedAgentSHA256 = sha256(agentId);
  if (options.agentSha256 !== undefined && options.agentSha256 !== derivedAgentSHA256) {
    throw new Error("cave_trajectory_agent_mismatch");
  }
  const provider = metadataString(result.provider, "provider", PROVIDER_ID);
  const model = metadataString(result.model, "model", MODEL_ID);
  const stopReason = boundedString(result.stopReason, "stop_reason", 64);
  const capBreached = requiredBoolean(result.capBreached, "cap_breached");
  const receipt = requiredRecord(result.receipt, "receipt");
  const contextBill = numericRecord(result.contextBill, "context_bill");
  const toolEffects = validatedToolEffects(options.toolEffects);
  const toolRows = receiptTools(receipt, result.toolCalls, toolEffects);
  const usageBasis = result.usageBasis === "provider_reported" ? "provider_reported" :
    result.usageBasis === "unavailable" ? "unavailable" : invalidEnum("usage_basis");
  result.priceBasis === "public_catalog" ? "public_catalog" :
    result.priceBasis === "unpriced" ? "unpriced" : invalidEnum("price_basis");
  nonNegativeFinite(result.costUsd, "cost_usd");
  const inputTokens = nonNegativeInteger(result.inputTokens, "input_tokens");
  const outputTokens = nonNegativeInteger(result.outputTokens, "output_tokens");
  const cacheReadTokens = nonNegativeInteger(result.cacheReadTokens, "cache_read_tokens");
  const cacheWriteTokens = nonNegativeInteger(result.cacheWriteTokens, "cache_write_tokens");
  const reasoningTokens = nonNegativeInteger(result.reasoningTokens, "reasoning_tokens");
  const usage = {
    provider,
    model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
  };
  const atStart = catalogCost(usage, options.accountingStartedAt);
  const atFinish = catalogCost(usage, options.accountingFinishedAt);
  const startFingerprint = catalogPriceFingerprint(provider, model, options.accountingStartedAt);
  const finishFingerprint = catalogPriceFingerprint(provider, model, options.accountingFinishedAt);
  // Never trust a caller's dollar field. Reprice official token buckets at the
  // owned run boundaries, and reject a recurring price transition.
  const repriced = usageBasis === "provider_reported" && atStart.priced && atFinish.priced &&
    startFingerprint !== undefined && startFingerprint === finishFingerprint && atStart.usd === atFinish.usd
    ? atStart
    : { priced: false, usd: 0 };
  const calls = Array.isArray(receipt.calls) ? receipt.calls.length : invalidNumber("model_calls");
  return {
    schema_version: TRAJECTORY_IR_SCHEMA_VERSION,
    case_sha256: sha256(options.caseId),
    lineage_sha256: sha256(options.lineageId),
    input_sha256: options.inputSha256,
    run_sha256: sha256(runId),
    agent_sha256: options.agentSha256 ?? derivedAgentSHA256,
    source: "caveman_run_result",
    split: options.split,
    provider,
    model,
    terminal: true,
    outcome: stopReason === "complete" && !capBreached ? "complete" : "stopped",
    usage_basis: usageBasis,
    price_basis: repriced.priced ? "public_catalog" : "unpriced",
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_tokens: cacheReadTokens,
    cache_write_tokens: cacheWriteTokens,
    reasoning_tokens: reasoningTokens,
    cost_usd: repriced.usd,
    latency_ms: nonNegativeFinite(result.latencyMs, "latency_ms"),
    model_calls: calls,
    context_bill: contextBill,
    tools: toolRows,
    evaluated_transform_ids: stringSet(result.evaluatedTransformIDs, "evaluated_transform_ids"),
    applied_transform_ids: stringSet(result.transformIDs, "applied_transform_ids"),
    recovery_resolved: requiredBoolean(result.recoveryResolved, "recovery_resolved"),
  };
}

function projectSpan(
  span: Record<string, unknown>,
  options: NormalizeTrajectoryOptions,
): Omit<NormalizedTrajectory, "trajectory_sha256"> {
  const attributes = spanAttributes(span.attributes);
  assertNoRawAttributeNames(attributes);
  const traceId = firstString(span.traceId, span.trace_id, attributes["trace_id"]);
  const spanId = firstString(span.spanId, span.span_id, attributes["span_id"]);
  if (traceId === undefined || spanId === undefined) throw new Error("cave_trajectory_span_identity_missing");
  const provider = firstString(
    attributes["gen_ai.system"], attributes["llm.provider"], attributes["cave.provider"],
  );
  const model = firstString(
    attributes["gen_ai.response.model"], attributes["gen_ai.request.model"],
    attributes["llm.model_name"], attributes["cave.model"],
  );
  if (provider === undefined || model === undefined) throw new Error("cave_trajectory_span_model_missing");
  metadataString(provider, "provider", PROVIDER_ID);
  metadataString(model, "model", MODEL_ID);
  const inputKey = firstPresentKey(attributes, [
    "gen_ai.usage.input_tokens", "llm.token_count.prompt", "cave.input_tokens",
  ]);
  const outputKey = firstPresentKey(attributes, [
    "gen_ai.usage.output_tokens", "llm.token_count.completion", "cave.output_tokens",
  ]);
  if (inputKey === undefined || outputKey === undefined) {
    throw new Error("cave_trajectory_span_usage_missing");
  }
  const latency = spanLatencyMs(span, attributes);
  const status = spanStatus(span, attributes);
  const source = attributes["openinference.span.kind"] === undefined
    ? "otel_span" as const
    : "openinference_span" as const;
  const toolName = firstString(attributes["tool.name"], attributes["cave.tool.name"]);
  const toolEffects = validatedToolEffects(options.toolEffects);
  const tools = toolName === undefined ? [] : [{
    tool_sha256: sha256(toolName),
    // Span labels are telemetry, not declarations. Trust only caller-owned policy.
    effect: toolEffects[toolName] ?? "external",
    calls: 1,
    errors: status === "error" ? 1 : 0,
  }];
  const explicitUsageBasis = attributes["cave.usage_basis"];
  explicitUsageBasis === "provider_reported" || explicitUsageBasis === undefined ||
    explicitUsageBasis === "unavailable" ? "unavailable" as const : invalidEnum("usage_basis");
  const cost = firstNumber(attributes["cave.cost_usd"], attributes["llm.cost.total"]);
  const explicitPriceBasis = attributes["cave.price_basis"];
  if (cost !== undefined) nonNegativeFinite(cost, "cost_usd");
  explicitPriceBasis === "public_catalog" ? "public_catalog" as const :
    explicitPriceBasis === undefined || explicitPriceBasis === "unpriced" ? "unpriced" as const :
      invalidEnum("price_basis");
  // Generic span attributes have no catalog/provenance authority. Keep their
  // token counts useful for profiling, but never let caller-owned labels or
  // cost fields mint public-catalog evidence.
  const priceBasis = "unpriced" as const;
  const declaredAgent = firstString(attributes["cave.agent_id"], attributes["agent.name"]);
  const declaredAgentSHA256 = declaredAgent === undefined
    ? undefined
    : sha256(boundedString(declaredAgent, "agent_id", 256));
  if (options.agentSha256 !== undefined && declaredAgentSHA256 !== undefined &&
      options.agentSha256 !== declaredAgentSHA256) {
    throw new Error("cave_trajectory_agent_mismatch");
  }
  return {
    schema_version: TRAJECTORY_IR_SCHEMA_VERSION,
    case_sha256: sha256(options.caseId),
    lineage_sha256: sha256(options.lineageId),
    input_sha256: options.inputSha256,
    run_sha256: sha256(`${traceId}:${spanId}`),
    agent_sha256: options.agentSha256 ?? declaredAgentSHA256 ?? sha256("unknown"),
    source,
    split: options.split,
    provider,
    model,
    terminal: status !== "unset",
    outcome: status === "error" ? "error" : status === "ok" ? "complete" : "stopped",
    usage_basis: "unavailable",
    price_basis: priceBasis,
    input_tokens: nonNegativeInteger(attributes[inputKey], "input_tokens"),
    output_tokens: nonNegativeInteger(attributes[outputKey], "output_tokens"),
    cache_read_tokens: optionalNonNegativeInteger(attributes["gen_ai.usage.cache_read.input_tokens"] ?? attributes["cave.cache_read_tokens"]),
    cache_write_tokens: optionalNonNegativeInteger(attributes["cave.cache_write_tokens"]),
    reasoning_tokens: optionalNonNegativeInteger(attributes["gen_ai.usage.output_tokens.reasoning"] ?? attributes["cave.reasoning_tokens"]),
    cost_usd: 0,
    latency_ms: latency,
    model_calls: optionalPositiveInteger(attributes["cave.model_calls"], 1),
    context_bill: numericRecord(attributes["cave.context_bill"] ?? {}, "context_bill"),
    tools,
    evaluated_transform_ids: optionalStringSet(attributes["cave.evaluated_transform_ids"]),
    applied_transform_ids: optionalStringSet(attributes["cave.applied_transform_ids"]),
    recovery_resolved: attributes["cave.recovery_resolved"] === true,
  };
}

function finalizeTrajectory(
  value: Omit<NormalizedTrajectory, "trajectory_sha256">,
): NormalizedTrajectory {
  const normalized = deepFreeze({
    ...value,
    context_bill: sortedNumericRecord(value.context_bill),
    tools: [...value.tools].sort((a, b) => a.tool_sha256.localeCompare(b.tool_sha256)),
    evaluated_transform_ids: [...new Set(value.evaluated_transform_ids)].sort(),
    applied_transform_ids: [...new Set(value.applied_transform_ids)].sort(),
  });
  const trajectory = deepFreeze({
    ...normalized,
    trajectory_sha256: sha256(stableStringify(normalized)),
  });
  validateNormalized(trajectory);
  return trajectory;
}

function validateNormalized(value: NormalizedTrajectory): void {
  if (value.schema_version !== TRAJECTORY_IR_SCHEMA_VERSION ||
      !HEX_64.test(value.trajectory_sha256) || !HEX_64.test(value.case_sha256) ||
      !HEX_64.test(value.lineage_sha256) || !HEX_64.test(value.input_sha256) ||
      !HEX_64.test(value.run_sha256) ||
      !HEX_64.test(value.agent_sha256) ||
      !["caveman_run_result", "otel_span", "openinference_span"].includes(value.source) ||
      !SPLITS.includes(value.split) || value.provider.length === 0 || value.model.length === 0 ||
      typeof value.terminal !== "boolean" || !["complete", "stopped", "error"].includes(value.outcome) ||
      !["provider_reported", "unavailable"].includes(value.usage_basis) ||
      !["public_catalog", "unpriced"].includes(value.price_basis) ||
      typeof value.recovery_resolved !== "boolean") {
    throw new Error("cave_trajectory_invalid:fields");
  }
  metadataString(value.provider, "provider", PROVIDER_ID);
  metadataString(value.model, "model", MODEL_ID);
  for (const [name, item] of Object.entries({
    input_tokens: value.input_tokens,
    output_tokens: value.output_tokens,
    cache_read_tokens: value.cache_read_tokens,
    cache_write_tokens: value.cache_write_tokens,
    reasoning_tokens: value.reasoning_tokens,
    model_calls: value.model_calls,
  })) {
    nonNegativeInteger(item, name);
  }
  nonNegativeFinite(value.cost_usd, "cost_usd");
  nonNegativeFinite(value.latency_ms, "latency_ms");
  numericRecord(value.context_bill, "context_bill");
  if (!Array.isArray(value.tools) || !Array.isArray(value.evaluated_transform_ids) ||
      !Array.isArray(value.applied_transform_ids)) throw new Error("cave_trajectory_invalid:arrays");
  for (const tool of value.tools) {
    if (!isRecord(tool) || !exactKeys(tool, ["tool_sha256", "effect", "calls", "errors"]) ||
        !HEX_64.test(String(tool.tool_sha256)) || !EFFECTS.includes(tool.effect as ToolEffect)) {
      throw new Error("cave_trajectory_invalid:tool");
    }
    nonNegativeInteger(tool.calls, "tool_calls");
    nonNegativeInteger(tool.errors, "tool_errors");
    if (Number(tool.errors) > Number(tool.calls)) throw new Error("cave_trajectory_invalid:tool_errors");
  }
  stringSet(value.evaluated_transform_ids, "evaluated_transform_ids");
  stringSet(value.applied_transform_ids, "applied_transform_ids");
}

function receiptTools(
  receipt: Record<string, unknown>,
  rawToolCalls: unknown,
  effects: Readonly<Record<string, ToolEffect>>,
): NormalizedToolActivity[] {
  const byName = new Map<string, { calls: number; errors: number }>();
  if (Array.isArray(receipt.tools)) {
    for (const row of receipt.tools) {
      if (!isRecord(row)) throw new Error("cave_trajectory_invalid:receipt_tool");
      const name = requiredString(row.name, "tool_name");
      byName.set(name, {
        calls: nonNegativeInteger(row.calls, "tool_calls"),
        errors: nonNegativeInteger(row.errors, "tool_errors"),
      });
    }
  } else if (Array.isArray(rawToolCalls)) {
    for (const item of rawToolCalls) {
      const name = requiredString(item, "tool_name");
      const row = byName.get(name) ?? { calls: 0, errors: 0 };
      row.calls++;
      byName.set(name, row);
    }
  } else {
    throw new Error("cave_trajectory_invalid:tool_calls");
  }
  return [...byName].map(([name, row]) => {
    if (row.errors > row.calls) throw new Error("cave_trajectory_invalid:tool_errors");
    return {
      tool_sha256: sha256(name),
      effect: effects[name] ?? "external",
      calls: row.calls,
      errors: row.errors,
    };
  });
}

function validatedToolEffects(
  value: NormalizeTrajectoryOptions["toolEffects"],
): Readonly<Record<string, ToolEffect>> {
  const normalized: Record<string, ToolEffect> = {};
  for (const [name, effect] of Object.entries(value ?? {})) {
    if (name.length === 0 || name.length > 256 || !EFFECTS.includes(effect)) {
      throw new Error("cave_trajectory_tool_effect_invalid");
    }
    normalized[name] = effect;
  }
  return normalized;
}

function validateOptions(options: NormalizeTrajectoryOptions): void {
  if (typeof options.caseId !== "string" || options.caseId.length === 0 ||
      options.caseId.length > 512) {
    throw new Error("cave_trajectory_case_id_required");
  }
  if (typeof options.lineageId !== "string" || options.lineageId.length === 0 ||
      options.lineageId.length > 512) {
    throw new Error("cave_trajectory_lineage_id_required");
  }
  if (typeof options.inputSha256 !== "string" || !HEX_64.test(options.inputSha256)) {
    throw new Error("cave_trajectory_input_digest_required");
  }
  if (options.agentSha256 !== undefined && !HEX_64.test(options.agentSha256)) {
    throw new Error("cave_trajectory_agent_digest_invalid");
  }
  if (!SPLITS.includes(options.split)) throw new Error("cave_trajectory_split_invalid");
  const boundaries = [options.accountingStartedAt, options.accountingFinishedAt];
  if (boundaries.some((value) => value !== undefined &&
    (!(value instanceof Date) || Number.isNaN(value.getTime()))) ||
    (boundaries[0] === undefined) !== (boundaries[1] === undefined)) {
    throw new Error("cave_trajectory_accounting_time_invalid");
  }
}

function looksLikeCavemanRunResult(value: Record<string, unknown>): boolean {
  return typeof value.runId === "string" && typeof value.agentId === "string" &&
    "contextIR" in value && "receipt" in value;
}

const RAW_FIELD = /^(?:prompt|prompts|completion|completions|message|messages|content|contents|result|response|input|output|text)$/i;
const RAW_ATTRIBUTE = /(?:^|[._])(?:prompt|prompts|completion|completions|message|messages|content|contents|input\.value|output\.value|response\.text|result)(?:$|[._])/i;
const OPENINFERENCE_TOKEN_COUNT_ATTRIBUTES = new Set([
  "llm.token_count.prompt",
  "llm.token_count.completion",
]);
const NUMERIC_TOKEN_ATTRIBUTES = new Set([
  "gen_ai.usage.input_tokens", "llm.token_count.prompt", "cave.input_tokens",
  "gen_ai.usage.output_tokens", "llm.token_count.completion", "cave.output_tokens",
  "gen_ai.usage.cache_read.input_tokens", "cave.cache_read_tokens",
  "cave.cache_write_tokens", "gen_ai.usage.output_tokens.reasoning",
  "cave.reasoning_tokens", "cave.model_calls",
]);

function assertNoRawContent(value: unknown, allowRootText: boolean, path: string[] = []): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoRawContent(item, false, [...path, String(index)]));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const rootRunText = allowRootText && path.length === 0 && key === "text";
    const numericUsage = isOpenInferenceTokenCount(key, child);
    const numericContextBill = isContextBillEntry(path, key, child);
    if (!rootRunText && !numericUsage && !numericContextBill &&
        (RAW_FIELD.test(key) || RAW_ATTRIBUTE.test(key))) {
      throw new Error(`cave_trajectory_raw_content_refused:${key}`);
    }
    if (!rootRunText) assertNoRawContent(child, false, [...path, key]);
  }
}

function assertNoRawAttributeNames(attributes: Record<string, unknown>): void {
  const forbidden = Object.entries(attributes).find(([key, value]) =>
    !isOpenInferenceTokenCount(key, value) && (RAW_FIELD.test(key) || RAW_ATTRIBUTE.test(key)));
  if (forbidden !== undefined) throw new Error(`cave_trajectory_raw_content_refused:${forbidden[0]}`);
}

function isOpenInferenceTokenCount(key: string, value: unknown): boolean {
  return OPENINFERENCE_TOKEN_COUNT_ATTRIBUTES.has(key) &&
    Number.isSafeInteger(value) && Number(value) >= 0;
}

function isContextBillEntry(path: readonly string[], key: string, value: unknown): boolean {
  const parent = path.at(-1);
  return ["contextBill", "context_bill", "cave.context_bill"].includes(parent ?? "") &&
    CONTEXT_KINDS.includes(key as ContextKind) &&
    Number.isSafeInteger(value) && Number(value) >= 0;
}

function spanAttributes(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (isRecord(value)) return { ...value };
  if (!Array.isArray(value)) throw new Error("cave_trajectory_span_attributes_invalid");
  const attributes: Record<string, unknown> = {};
  for (const item of value) {
    if (!isRecord(item) || typeof item.key !== "string" || !("value" in item)) {
      throw new Error("cave_trajectory_span_attributes_invalid");
    }
    attributes[item.key] = otelValue(item.value, item.key);
  }
  return attributes;
}

function otelValue(value: unknown, attributeKey?: string): unknown {
  if (!isRecord(value)) return value;
  for (const key of ["stringValue", "doubleValue", "boolValue"] as const) {
    if (key in value) return value[key];
  }
  if ("intValue" in value) {
    const parsed = parseOtelInteger(value.intValue);
    if (attributeKey !== undefined && NUMERIC_TOKEN_ATTRIBUTES.has(attributeKey) && parsed < 0) {
      throw new Error("cave_trajectory_span_attribute_value_invalid");
    }
    return parsed;
  }
  if (isRecord(value.arrayValue) && Array.isArray(value.arrayValue.values)) {
    return value.arrayValue.values.map((item) => otelValue(item));
  }
  throw new Error("cave_trajectory_span_attribute_value_invalid");
}

function parseOtelInteger(value: unknown): number {
  if (typeof value === "number") {
    if (Number.isSafeInteger(value)) return value;
    throw new Error("cave_trajectory_span_attribute_value_invalid");
  }
  if (typeof value !== "string" || !/^-?(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error("cave_trajectory_span_attribute_value_invalid");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("cave_trajectory_span_attribute_value_invalid");
  }
  return parsed;
}

function spanLatencyMs(span: Record<string, unknown>, attributes: Record<string, unknown>): number {
  const direct = firstNumber(attributes["cave.latency_ms"], attributes["latency_ms"], attributes["duration_ms"]);
  if (direct !== undefined) return nonNegativeFinite(direct, "latency_ms");
  const start = numericLike(span.startTimeUnixNano ?? span.start_time_unix_nano);
  const end = numericLike(span.endTimeUnixNano ?? span.end_time_unix_nano);
  if (start === undefined || end === undefined || end < start) throw new Error("cave_trajectory_span_latency_missing");
  return nonNegativeFinite((end - start) / 1_000_000, "latency_ms");
}

function spanStatus(
  span: Record<string, unknown>,
  attributes: Record<string, unknown>,
): "ok" | "error" | "unset" {
  const rawStatus = isRecord(span.status) ? span.status.code : span.status;
  const raw = firstDefined(rawStatus, attributes["otel.status_code"], attributes["status.code"]);
  if (raw === undefined) {
    return attributes["cave.terminal"] === true ? "ok" : "unset";
  }
  const status = typeof raw === "string" ? raw.toLowerCase() :
    Number.isSafeInteger(raw) ? String(raw) : invalidEnum("span_status");
  if (["ok", "status_code_ok", "1"].includes(status)) return "ok";
  if (["error", "status_code_error", "2"].includes(status)) return "error";
  if (["unset", "status_code_unset", "0"].includes(status)) return "unset";
  throw new Error("cave_trajectory_span_status_unknown");
}

function numericRecord(
  value: unknown,
  name: string,
): Readonly<Partial<Record<ContextKind, number>>> {
  if (!isRecord(value)) throw new Error(`cave_trajectory_invalid:${name}`);
  const result: Partial<Record<ContextKind, number>> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!CONTEXT_KINDS.includes(key as ContextKind)) {
      throw new Error(`cave_trajectory_invalid:${name}`);
    }
    result[key as ContextKind] = nonNegativeInteger(item, name);
  }
  return sortedNumericRecord(result);
}

function sortedNumericRecord(
  value: Readonly<Partial<Record<ContextKind, number>>>,
): Readonly<Partial<Record<ContextKind, number>>> {
  return Object.freeze(Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
  )) as Readonly<Partial<Record<ContextKind, number>>>;
}

function stringSet(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 64 ||
      value.some((item) => typeof item !== "string" || !TRANSFORM_ID.test(item))) {
    throw new Error(`cave_trajectory_invalid:${name}`);
  }
  return Object.freeze([...new Set(value as string[])].sort());
}

function optionalStringSet(value: unknown): readonly string[] {
  return value === undefined ? Object.freeze([]) : stringSet(value, "span_transform_ids");
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`cave_trajectory_invalid:${name}`);
  return value;
}

function boundedString(value: unknown, name: string, maxLength: number): string {
  const parsed = requiredString(value, name);
  if (parsed.length > maxLength) throw new Error(`cave_trajectory_invalid:${name}`);
  return parsed;
}

function metadataString(value: unknown, name: string, pattern: RegExp): string {
  const parsed = boundedString(value, name, 192);
  if (!pattern.test(parsed)) throw new Error(`cave_trajectory_invalid:${name}`);
  return parsed;
}

function requiredRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`cave_trajectory_invalid:${name}`);
  return value;
}

function requiredBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`cave_trajectory_invalid:${name}`);
  return value;
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`cave_trajectory_invalid:${name}`);
  return Number(value);
}

function optionalNonNegativeInteger(value: unknown): number {
  return value === undefined ? 0 : nonNegativeInteger(value, "span_tokens");
}

function optionalPositiveInteger(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = nonNegativeInteger(value, "span_model_calls");
  if (parsed === 0) throw new Error("cave_trajectory_invalid:span_model_calls");
  return parsed;
}

function nonNegativeFinite(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`cave_trajectory_invalid:${name}`);
  }
  return value;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

function firstNumber(...values: unknown[]): number | undefined {
  return values.find((value): value is number => typeof value === "number" && Number.isFinite(value));
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined);
}

function numericLike(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^[0-9]+$/.test(value)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function firstPresentKey(value: Record<string, unknown>, keys: string[]): string | undefined {
  return keys.find((key) => value[key] !== undefined);
}

function invalidEnum(name: string): never {
  throw new Error(`cave_trajectory_invalid:${name}`);
}

function invalidNumber(name: string): never {
  throw new Error(`cave_trajectory_invalid:${name}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
