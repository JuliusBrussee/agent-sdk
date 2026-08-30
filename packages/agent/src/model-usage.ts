import { snapshotDataRecord } from "./strict-data.js";

export type ModelUsageTokenCount = number | null;

export type ModelUsageCost =
  | {
    readonly status: "estimated";
    readonly basis: "public_catalog";
    readonly usd: number;
  }
  | { readonly status: "unpriced" }
  | { readonly status: "unknown" };

/**
 * One provider call's disjoint usage. `inputTokens` excludes cache read/write;
 * reasoning tokens are a subset of output tokens. `null` means unknown and is
 * never coerced to zero. Raw provider payloads are intentionally excluded.
 */
export interface ModelUsage {
  readonly schemaVersion: 1;
  readonly provider: string;
  readonly model: string;
  readonly inputTokens: ModelUsageTokenCount;
  readonly outputTokens: ModelUsageTokenCount;
  readonly cacheReadTokens: ModelUsageTokenCount;
  readonly cacheWriteTokens: ModelUsageTokenCount;
  readonly reasoningTokens: ModelUsageTokenCount;
  readonly totalTokens: ModelUsageTokenCount;
  readonly cost: ModelUsageCost;
}

export interface CompleteModelUsage extends ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
  readonly totalTokens: number;
}

export type ModelUsageAccountingStatus =
  | "complete_priced"
  | "complete_unpriced"
  | "incomplete";

const USAGE_KEYS = Object.freeze([
  "schemaVersion",
  "provider",
  "model",
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
  "totalTokens",
  "cost",
]);
const COST_KEYS = Object.freeze(["status", "basis", "usd"]);
const PROVIDER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_MODEL_BYTES = 1_024;
const TOKEN_FIELDS = Object.freeze([
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
  "totalTokens",
] as const);
const DISJOINT_FIELDS = Object.freeze([
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
] as const);

/** Validate, detach, and freeze one model-call usage record. */
export function defineModelUsage(value: unknown): ModelUsage {
  const usage = snapshotDataRecord(
    value,
    USAGE_KEYS,
    USAGE_KEYS,
    () => { throw new Error("cave_model_usage_invalid"); },
  );
  if (usage["schemaVersion"] !== 1 ||
      typeof usage["provider"] !== "string" || !PROVIDER.test(usage["provider"]) ||
      !isModel(usage["model"])) {
    throw new Error("cave_model_usage_invalid");
  }

  const counts: Record<typeof TOKEN_FIELDS[number], ModelUsageTokenCount> = {
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
    totalTokens: null,
  };
  for (const field of TOKEN_FIELDS) {
    const count = usage[field];
    if (count !== null && (!Number.isSafeInteger(count) || (count as number) < 0)) {
      throw new Error(`cave_model_usage_invalid:${field}`);
    }
    counts[field] = count as ModelUsageTokenCount;
  }

  if (counts.reasoningTokens !== null && counts.outputTokens !== null &&
      counts.reasoningTokens > counts.outputTokens) {
    throw new Error("cave_model_usage_invalid:reasoningTokens");
  }
  const knownMinimum = DISJOINT_FIELDS.reduce(
    (sum, field) => sum + (counts[field] ?? 0),
    0,
  );
  if (counts.totalTokens !== null && counts.totalTokens < knownMinimum) {
    throw new Error("cave_model_usage_invalid:totalTokens");
  }
  const complete = DISJOINT_FIELDS.every((field) => counts[field] !== null) &&
    counts.reasoningTokens !== null;
  if (complete && counts.totalTokens !== knownMinimum) {
    throw new Error("cave_model_usage_invalid:totalTokens");
  }

  const cost = normalizeCost(usage["cost"], complete);
  return Object.freeze({
    schemaVersion: 1,
    provider: usage["provider"],
    model: usage["model"] as string,
    ...counts,
    cost,
  });
}

export function modelUsageAccountingStatus(
  value: ModelUsage,
): ModelUsageAccountingStatus {
  const usage = defineModelUsage(value);
  if (!hasCompleteCounts(usage) || usage.cost.status === "unknown") return "incomplete";
  return usage.cost.status === "estimated" ? "complete_priced" : "complete_unpriced";
}

/** Fail closed where token accounting requires every disjoint component. */
export function requireCompleteModelUsage(value: ModelUsage): CompleteModelUsage {
  const usage = defineModelUsage(value);
  if (!hasCompleteCounts(usage)) throw new Error("cave_model_usage_incomplete");
  return usage;
}

function hasCompleteCounts(value: ModelUsage): value is CompleteModelUsage {
  return TOKEN_FIELDS.every((field) => value[field] !== null);
}

function normalizeCost(value: unknown, complete: boolean): ModelUsageCost {
  const cost = snapshotDataRecord(
    value,
    COST_KEYS,
    ["status"],
    () => { throw new Error("cave_model_usage_invalid:cost"); },
  );
  if (cost["status"] === "estimated") {
    if (!complete || cost["basis"] !== "public_catalog" ||
        typeof cost["usd"] !== "number" || !Number.isFinite(cost["usd"]) ||
        cost["usd"] < 0) {
      throw new Error("cave_model_usage_invalid:cost");
    }
    return Object.freeze({
      status: "estimated",
      basis: "public_catalog",
      usd: cost["usd"],
    });
  }
  if ((cost["status"] !== "unpriced" && cost["status"] !== "unknown") ||
      Object.hasOwn(cost, "basis") || Object.hasOwn(cost, "usd") ||
      (cost["status"] === "unpriced" && !complete)) {
    throw new Error("cave_model_usage_invalid:cost");
  }
  return Object.freeze({ status: cost["status"] });
}

function isModel(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_MODEL_BYTES && !/[\0\r\n]/u.test(value);
}
