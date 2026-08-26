import { sha256, stableStringify } from "./context-ir.js";
import type { ToolEffect } from "./primitives.js";
import {
  parseNormalizedTrajectory,
  type NormalizedToolActivity,
  type NormalizedTrajectory,
  type WorkloadSplit,
} from "./trajectory-ir.js";

export const WORKLOAD_PROFILE_SCHEMA_VERSION = 1 as const;

export interface ProfileToolEffect {
  readonly tool_sha256: string;
  readonly effect: ToolEffect;
  readonly calls: number;
  readonly errors: number;
}

export interface WorkloadPartition {
  readonly split: WorkloadSplit;
  readonly split_sha256: string;
  readonly trajectory_count: number;
  readonly case_count: number;
  readonly model_calls: number;
  readonly provider_visible_tokens: number;
  /** Public-catalog subtotal for priced rows only; completeness is reported beside it. */
  readonly catalog_cost_usd: number;
  readonly provider_reported_count: number;
  readonly usage_incomplete_count: number;
  readonly priced_count: number;
  readonly unpriced_count: number;
  readonly error_count: number;
  readonly tool_effects: readonly ProfileToolEffect[];
  readonly trajectories: readonly NormalizedTrajectory[];
}

export interface WorkloadProfile {
  readonly schema_version: typeof WORKLOAD_PROFILE_SCHEMA_VERSION;
  readonly profile_sha256: string;
  readonly partitions: {
    readonly profile: WorkloadPartition;
    readonly development: WorkloadPartition;
    readonly holdout: WorkloadPartition;
  };
  readonly tool_effects: readonly ProfileToolEffect[];
}

const SPLITS: readonly WorkloadSplit[] = ["profile", "development", "holdout"];
const EFFECT_RANK: Readonly<Record<ToolEffect, number>> = {
  read: 0,
  idempotent: 1,
  write: 2,
  external: 3,
};

/**
 * Build a deterministic, content-blind workload profile. Input order has no
 * effect on any digest. A workload case may occur in exactly one split.
 */
export function createWorkloadProfile(
  input: readonly NormalizedTrajectory[],
): WorkloadProfile {
  return createProfile(input, false);
}

/**
 * Build compiler input before development selection and holdout execution.
 * Only profile observations exist at this point by design. Development and
 * holdout stay empty until their eval runners execute, so compiler cannot
 * inspect either before plan freeze.
 */
export function createCompilerWorkloadProfile(
  input: readonly NormalizedTrajectory[],
): WorkloadProfile {
  return createProfile(input, true);
}

function createProfile(
  input: readonly NormalizedTrajectory[],
  allowPendingValidation: boolean,
): WorkloadProfile {
  if (!Array.isArray(input) || input.length === 0) throw new Error("cave_profile_empty");
  const trajectories = input.map((item) => parseNormalizedTrajectory(item));
  assertIsolation(trajectories);
  const bySplit = Object.fromEntries(SPLITS.map((split) => [
    split,
    trajectories.filter((trajectory) => trajectory.split === split),
  ])) as Record<WorkloadSplit, NormalizedTrajectory[]>;
  if (bySplit.profile.length === 0) throw new Error("cave_profile_split_empty:profile");
  if (allowPendingValidation &&
      (bySplit.development.length !== 0 || bySplit.holdout.length !== 0)) {
    throw new Error("cave_profile_compiler_input_must_be_profile_only");
  }
  if (!allowPendingValidation) {
    for (const split of ["development", "holdout"] as const) {
      if (bySplit[split].length === 0) throw new Error(`cave_profile_split_empty:${split}`);
    }
  }
  const partitions = deepFreeze({
    profile: partition("profile", bySplit.profile),
    development: partition("development", bySplit.development),
    holdout: partition("holdout", bySplit.holdout),
  });
  const payload = deepFreeze({
    schema_version: WORKLOAD_PROFILE_SCHEMA_VERSION,
    partitions,
    tool_effects: mergeToolEffects(trajectories.flatMap((trajectory) => trajectory.tools)),
  });
  return deepFreeze({
    ...payload,
    profile_sha256: sha256(stableStringify(payload)),
  });
}

/** Strict parser: unknown fields, altered summaries, and altered digests fail. */
export function parseWorkloadProfile(value: unknown): WorkloadProfile {
  if (!isRecord(value) || !exactKeys(value, ["schema_version", "profile_sha256", "partitions", "tool_effects"]) ||
      value.schema_version !== WORKLOAD_PROFILE_SCHEMA_VERSION ||
      typeof value.profile_sha256 !== "string" || !isRecord(value.partitions) ||
      !exactKeys(value.partitions, SPLITS) || !Array.isArray(value.tool_effects)) {
    throw new Error("cave_profile_invalid:shape");
  }
  const trajectories: NormalizedTrajectory[] = [];
  for (const split of SPLITS) {
    const rawPartition = value.partitions[split];
    if (!isRecord(rawPartition) || !Array.isArray(rawPartition.trajectories)) {
      throw new Error("cave_profile_invalid:partition");
    }
    trajectories.push(...rawPartition.trajectories.map(parseNormalizedTrajectory));
  }
  const development = value.partitions.development;
  const holdout = value.partitions.holdout;
  if (!isRecord(development) || !isRecord(holdout)) {
    throw new Error("cave_profile_invalid:partition");
  }
  const pendingDevelopment = development.trajectory_count === 0;
  const pendingHoldout = holdout.trajectory_count === 0;
  if (pendingDevelopment !== pendingHoldout) {
    throw new Error("cave_profile_invalid:partial_validation_partition");
  }
  const validationPending = pendingDevelopment && pendingHoldout;
  const rebuilt = validationPending
    ? createCompilerWorkloadProfile(trajectories)
    : createWorkloadProfile(trajectories);
  if (stableStringify(rebuilt) !== stableStringify(value)) {
    throw new Error("cave_profile_invalid:digest_or_summary");
  }
  return rebuilt;
}

export function workloadSplitSHA256(profile: WorkloadProfile, split: WorkloadSplit): string {
  return parseWorkloadProfile(profile).partitions[split].split_sha256;
}

function partition(split: WorkloadSplit, input: NormalizedTrajectory[]): WorkloadPartition {
  const trajectories = [...input].sort((a, b) =>
    a.case_sha256.localeCompare(b.case_sha256) ||
    a.run_sha256.localeCompare(b.run_sha256) ||
    a.trajectory_sha256.localeCompare(b.trajectory_sha256));
  const toolEffects = mergeToolEffects(trajectories.flatMap((trajectory) => trajectory.tools));
  const summary = {
    split,
    trajectory_count: trajectories.length,
    case_count: new Set(trajectories.map((trajectory) => trajectory.case_sha256)).size,
    model_calls: trajectories.reduce((sum, trajectory) => sum + trajectory.model_calls, 0),
    provider_visible_tokens: trajectories.reduce((sum, trajectory) =>
      sum + trajectory.input_tokens + trajectory.output_tokens +
        trajectory.cache_read_tokens + trajectory.cache_write_tokens, 0),
    catalog_cost_usd: roundUsd(trajectories.reduce((sum, trajectory) =>
      sum + (trajectory.price_basis === "public_catalog" ? trajectory.cost_usd : 0), 0)),
    provider_reported_count: trajectories.filter((trajectory) =>
      trajectory.usage_basis === "provider_reported").length,
    usage_incomplete_count: trajectories.filter((trajectory) =>
      trajectory.usage_basis !== "provider_reported").length,
    priced_count: trajectories.filter((trajectory) =>
      trajectory.price_basis === "public_catalog").length,
    unpriced_count: trajectories.filter((trajectory) =>
      trajectory.price_basis !== "public_catalog").length,
    error_count: trajectories.filter((trajectory) => trajectory.outcome === "error").length,
    tool_effects: toolEffects,
    trajectories,
  };
  return deepFreeze({
    ...summary,
    split_sha256: sha256(stableStringify(summary)),
  });
}

function assertIsolation(trajectories: readonly NormalizedTrajectory[]): void {
  const seenTrajectories = new Set<string>();
  const seenRuns = new Set<string>();
  const splitByCase = new Map<string, WorkloadSplit>();
  const splitByLineage = new Map<string, WorkloadSplit>();
  for (const trajectory of trajectories) {
    if (seenTrajectories.has(trajectory.trajectory_sha256)) {
      throw new Error("cave_profile_duplicate_trajectory");
    }
    seenTrajectories.add(trajectory.trajectory_sha256);
    if (seenRuns.has(trajectory.run_sha256)) throw new Error("cave_profile_duplicate_run");
    seenRuns.add(trajectory.run_sha256);
    const existing = splitByCase.get(trajectory.case_sha256);
    if (existing !== undefined && existing !== trajectory.split) {
      throw new Error("cave_profile_split_overlap");
    }
    splitByCase.set(trajectory.case_sha256, trajectory.split);
    const lineageSplit = splitByLineage.get(trajectory.lineage_sha256);
    if (lineageSplit !== undefined && lineageSplit !== trajectory.split) {
      throw new Error("cave_profile_lineage_overlap");
    }
    splitByLineage.set(trajectory.lineage_sha256, trajectory.split);
  }
}

function mergeToolEffects(tools: readonly NormalizedToolActivity[]): readonly ProfileToolEffect[] {
  const merged = new Map<string, { effect: ToolEffect; calls: number; errors: number }>();
  for (const tool of tools) {
    const current = merged.get(tool.tool_sha256);
    if (current === undefined) {
      merged.set(tool.tool_sha256, { effect: tool.effect, calls: tool.calls, errors: tool.errors });
      continue;
    }
    current.effect = EFFECT_RANK[tool.effect] > EFFECT_RANK[current.effect] ? tool.effect : current.effect;
    current.calls += tool.calls;
    current.errors += tool.errors;
  }
  return deepFreeze([...merged.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([tool_sha256, value]) => ({ tool_sha256, ...value })));
}

function roundUsd(value: number): number {
  return Math.round((value + Number.EPSILON) * 1e10) / 1e10;
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
