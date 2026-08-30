import { readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import type { CaveBuildLock, CavePlan } from "./build.js";
import { catalogPriceFingerprint } from "./catalog.js";
import { sha256, stableStringify, type ContextIR } from "./context-ir.js";
import {
  prepareLockedHarnessExecution,
  validateProviderUsage,
} from "./execution-kernel.js";

export type HarnessID = "pi" | "claude" | "vercel-ai-sdk" | "eve" | "mastra";

export const EVE_VERSION = "0.29.2";

export interface HarnessRequest {
  build: CaveBuildLock;
  contextIR: ContextIR;
  plan: CavePlan;
  prompt: string;
  runID: string;
  evaluatedTransformIDs: string[];
  appliedTransformIDs: string[];
  recoveryResolved: boolean;
  signal?: AbortSignal;
}

export interface HarnessExecution {
  terminal: boolean;
  text: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  costUsd: number;
  usageBasis: "provider_reported" | "missing";
  priceBasis: "public_catalog" | "unpriced";
  evaluatedTransformIDs: string[];
  appliedTransformIDs: string[];
  recoveryResolved: boolean;
  latencyMs: number;
}

export interface HarnessResult extends HarnessExecution {
  harness: HarnessID;
  adapterBuildSHA256: string;
  adapterContractSHA256: string;
  sourceBuildSHA256: string;
  planSHA256: string;
  contextIRSHA256: string;
  claimBasis: "inferred";
  verifiedSavingsUsd: 0;
}

export interface HarnessAdapter {
  readonly id: HarnessID;
  readonly version: string;
  readonly manifest: HarnessAdapterManifest;
  readonly contractSHA256: string;
  run(request: HarnessRequest): Promise<HarnessResult>;
}

const HARNESS_RESULT_KEYS = [
  "terminal", "text", "provider", "model", "inputTokens", "outputTokens",
  "cacheReadTokens", "cacheWriteTokens", "reasoningTokens", "totalTokens",
  "costUsd", "usageBasis", "priceBasis", "evaluatedTransformIDs",
  "appliedTransformIDs", "recoveryResolved", "latencyMs", "harness",
  "adapterBuildSHA256", "adapterContractSHA256", "sourceBuildSHA256",
  "planSHA256", "contextIRSHA256", "claimBasis", "verifiedSavingsUsd",
] as const;

/** Revalidate a caller-controlled adapter result before exposing any claim. */
export function validateHarnessResult(
  value: unknown,
  input: {
    readonly adapter: HarnessAdapter;
    readonly request: HarnessRequest;
    /** Trusted times captured around adapter.run by the owning pipeline. */
    readonly accountingStartedAt: Date;
    readonly accountingFinishedAt: Date;
  },
): HarnessResult {
  if (!isRecord(value) || !exactObjectKeys(value, HARNESS_RESULT_KEYS)) {
    throw new Error("cave_harness_result_shape_invalid");
  }
  const execution = snapshotExecution(value as unknown as HarnessExecution);
  const prepared = prepareLockedHarnessExecution({
    build: input.request.build,
    harness: input.adapter.id,
    adapterVersion: input.adapter.version,
    upstreamVersion: input.adapter.manifest.upstreamVersion,
    contextIR: input.request.contextIR,
    plan: input.request.plan,
  });
  validateTransformEvidence(input.request, prepared.plan);
  validateExecution(
    execution,
    prepared.plan,
    input.accountingStartedAt,
    input.accountingFinishedAt,
  );
  if (canonicalStringSet(execution.evaluatedTransformIDs) !==
        canonicalStringSet(input.request.evaluatedTransformIDs) ||
      canonicalStringSet(execution.appliedTransformIDs) !==
        canonicalStringSet(input.request.appliedTransformIDs) ||
      execution.recoveryResolved !== input.request.recoveryResolved) {
    throw new Error("cave_harness_result_evidence_mismatch");
  }
  const expectedAdapterBuild = sha256(stableStringify({
    harness: input.adapter.id,
    version: input.adapter.version,
    contractSHA256: input.adapter.contractSHA256,
    sourceBuildSHA256: prepared.build.build_sha256,
  }));
  if (value.harness !== input.adapter.id ||
      value.adapterBuildSHA256 !== expectedAdapterBuild ||
      value.adapterContractSHA256 !== input.adapter.contractSHA256 ||
      value.sourceBuildSHA256 !== prepared.build.build_sha256 ||
      value.planSHA256 !== prepared.planSHA256 ||
      value.contextIRSHA256 !== prepared.contextIRSHA256) {
    throw new Error("cave_harness_result_identity_mismatch");
  }
  if (value.claimBasis !== "inferred" || value.verifiedSavingsUsd !== 0) {
    throw new Error("cave_harness_result_claim_invalid");
  }
  return deepFreeze({
    ...execution,
    harness: input.adapter.id,
    adapterBuildSHA256: expectedAdapterBuild,
    adapterContractSHA256: input.adapter.contractSHA256,
    sourceBuildSHA256: prepared.build.build_sha256,
    planSHA256: prepared.planSHA256,
    contextIRSHA256: prepared.contextIRSHA256,
    claimBasis: "inferred" as const,
    verifiedSavingsUsd: 0 as const,
  });
}

export type HarnessInvoke = (request: Readonly<HarnessRequest>) => Promise<HarnessExecution>;

export interface HarnessAdapterIdentity {
  adapterVersion: string;
  upstreamVersion: string;
  bundleSHA256: string;
  dependencyLockSHA256: string;
}

export interface HarnessAdapterManifest extends HarnessAdapterIdentity {
  schemaVersion: 1;
  harness: HarnessID;
  wireContract: Readonly<Record<string, unknown>>;
}

export function createHarnessAdapter(
  id: HarnessID,
  identity: HarnessAdapterIdentity,
  wireContract: Readonly<Record<string, unknown>>,
  invoke: HarnessInvoke,
): HarnessAdapter {
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/.test(identity.adapterVersion)) {
    throw new Error("cave_harness_adapter_version_invalid");
  }
  if (!/^[0-9A-Za-z][0-9A-Za-z._+-]{0,127}$/.test(identity.upstreamVersion)) {
    throw new Error("cave_harness_upstream_version_invalid");
  }
  if (!/^[0-9a-f]{64}$/.test(identity.bundleSHA256) ||
      !/^[0-9a-f]{64}$/.test(identity.dependencyLockSHA256)) {
    throw new Error("cave_harness_artifact_digest_invalid");
  }
  const manifest = deepFreeze({
    schemaVersion: 1 as const,
    harness: id,
    adapterVersion: identity.adapterVersion,
    upstreamVersion: identity.upstreamVersion,
    bundleSHA256: identity.bundleSHA256,
    dependencyLockSHA256: identity.dependencyLockSHA256,
    wireContract: canonicalRecord(wireContract),
  });
  const contractSHA256 = sha256(stableStringify(manifest));
  return Object.freeze({
    id,
    version: identity.adapterVersion,
    manifest,
    contractSHA256,
    async run(request: HarnessRequest): Promise<HarnessResult> {
      const frozenRequest = snapshotRequest(request);
      const prepared = prepareLockedHarnessExecution({
        build: frozenRequest.build,
        harness: id,
        adapterVersion: identity.adapterVersion,
        upstreamVersion: identity.upstreamVersion,
        contextIR: frozenRequest.contextIR,
        plan: frozenRequest.plan,
      });
      const { build, planSHA256, contextIRSHA256 } = prepared;
      if (typeof frozenRequest.prompt !== "string" || frozenRequest.prompt.length === 0 ||
          typeof frozenRequest.runID !== "string" || frozenRequest.runID.length === 0) {
        throw new Error("cave_harness_request_invalid");
      }
      if (isAborted(frozenRequest.signal)) throw new Error("cave_harness_aborted");
      validateTransformEvidence(frozenRequest, frozenRequest.plan);
      const accountingStartedAt = new Date();
      const execution = snapshotExecution(await invoke(frozenRequest));
      const accountingFinishedAt = new Date();
      if (isAborted(frozenRequest.signal)) throw new Error("cave_harness_aborted");
      validateExecution(execution, frozenRequest.plan, accountingStartedAt, accountingFinishedAt);
      return {
        terminal: execution.terminal,
        text: execution.text,
        provider: execution.provider,
        model: execution.model,
        inputTokens: execution.inputTokens,
        outputTokens: execution.outputTokens,
        cacheReadTokens: execution.cacheReadTokens,
        cacheWriteTokens: execution.cacheWriteTokens,
        reasoningTokens: execution.reasoningTokens,
        totalTokens: execution.totalTokens,
        costUsd: execution.costUsd,
        usageBasis: execution.usageBasis,
        priceBasis: execution.priceBasis,
        evaluatedTransformIDs: [...execution.evaluatedTransformIDs],
        appliedTransformIDs: [...execution.appliedTransformIDs],
        recoveryResolved: execution.recoveryResolved,
        latencyMs: execution.latencyMs,
        harness: id,
        adapterBuildSHA256: sha256(stableStringify({
          harness: id,
          version: identity.adapterVersion,
          contractSHA256,
          sourceBuildSHA256: build.build_sha256,
        })),
        adapterContractSHA256: contractSHA256,
        sourceBuildSHA256: build.build_sha256,
        planSHA256,
        contextIRSHA256,
        claimBasis: "inferred",
        verifiedSavingsUsd: 0,
      };
    },
  });
}

export const createPiAdapter = (identity: HarnessAdapterIdentity, invoke: HarnessInvoke) =>
  createHarnessAdapter("pi", identity, {
    kind: "caveman-pi",
    version: 1,
    request: "HarnessRequest.v1",
    response: "HarnessExecution.v1",
  }, invoke);

export const createClaudeAdapter = (identity: HarnessAdapterIdentity, invoke: HarnessInvoke) =>
  createHarnessAdapter("claude", identity, {
    kind: "caveman-claude",
    version: 1,
    request: "HarnessRequest.v1",
    response: "HarnessExecution.v1",
  }, invoke);

export interface EveMessageResponseBinding {
  result(): Promise<{
    message: string | undefined;
    status: "completed" | "failed" | "waiting";
    events: unknown[];
  }>;
}

export interface EveSessionBinding {
  send(input: { message: string; signal?: AbortSignal }): Promise<EveMessageResponseBinding>;
}

export function createEveAdapter(
  identity: HarnessAdapterIdentity,
  session: EveSessionBinding,
): HarnessAdapter {
  assertSupportedUpstream(identity, EVE_VERSION, "eve", "eve");
  return createHarnessAdapter("eve", identity, {
    package: "eve/client",
    class: "ClientSession",
    method: "send.result",
    usage: "step.completed.data.usage",
  }, async (request) => {
    const accountingAt = new Date();
    const startedAt = performance.now();
    const response = await session.send({
      message: request.prompt,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    const result = await response.result();
    if (result.status !== "completed") throw new Error(`cave_eve_terminal_${result.status}`);
    const identity = eveRuntimeIdentity(result.events);
    if (identity.upstreamVersion !== request.build.harness.upstream_version) {
      throw new Error("cave_harness_upstream_version_mismatch");
    }
    const usage = usageFromEveEvents(result.events, request.plan.reasoning !== "none");
    return harnessExecution({
      request,
      text: result.message ?? "",
      provider: identity.provider,
      model: identity.model,
      usage,
      latencyMs: Math.round(performance.now() - startedAt),
      accountingAt,
    });
  });
}

interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

function harnessExecution(input: {
  request: Readonly<HarnessRequest>;
  text: string;
  provider: string;
  model: string;
  usage: NormalizedUsage;
  latencyMs: number;
  accountingAt: Date;
}): HarnessExecution {
  const expected = expectedProviderModel(input.request.plan);
  if (input.provider !== expected.provider || input.model !== expected.model) {
    throw new Error("cave_harness_incomplete_evidence");
  }
  const priced = validateProviderUsage({
    provider: input.provider,
    model: input.model,
    ...input.usage,
  }, { requirePriced: true, accountingAt: input.accountingAt });
  return {
    terminal: true,
    text: input.text,
    provider: input.provider,
    model: input.model,
    ...input.usage,
    costUsd: priced.catalogCostUsd,
    usageBasis: "provider_reported",
    priceBasis: "public_catalog",
    evaluatedTransformIDs: [...input.request.evaluatedTransformIDs],
    appliedTransformIDs: [...input.request.appliedTransformIDs],
    recoveryResolved: input.request.recoveryResolved,
    latencyMs: input.latencyMs,
  };
}

function usageFromEveEvents(events: unknown[], reasoningRequired: boolean): NormalizedUsage {
  let totalInputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let steps = 0;
  for (const event of events) {
    if (!isRecord(event) || event.type !== "step.completed" || !isRecord(event.data)) continue;
    const usage = record(event.data.usage, "cave_eve_usage_missing");
    totalInputTokens += strictInteger(usage.inputTokens, "cave_eve_usage_missing");
    outputTokens += strictInteger(usage.outputTokens, "cave_eve_usage_missing");
    cacheReadTokens += strictInteger(usage.cacheReadTokens, "cave_eve_usage_missing");
    cacheWriteTokens += strictInteger(usage.cacheWriteTokens, "cave_eve_usage_missing");
    steps++;
  }
  if (steps === 0 || reasoningRequired) throw new Error("cave_eve_usage_missing");
  if (cacheReadTokens + cacheWriteTokens > totalInputTokens) {
    throw new Error("cave_eve_usage_missing");
  }
  const inputTokens = totalInputTokens - cacheReadTokens - cacheWriteTokens;
  return normalizeUsage({
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens: 0,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
  }, false, "cave_eve_usage_missing");
}

function normalizeUsage(
  value: Record<keyof NormalizedUsage, unknown>,
  reasoningRequired: boolean,
  error: string,
): NormalizedUsage {
  const reasoningTokens = reasoningRequired
    ? strictInteger(value.reasoningTokens, error)
    : optionalInteger(value.reasoningTokens, error);
  const usage = {
    inputTokens: strictInteger(value.inputTokens, error),
    outputTokens: strictInteger(value.outputTokens, error),
    cacheReadTokens: strictInteger(value.cacheReadTokens, error),
    cacheWriteTokens: strictInteger(value.cacheWriteTokens, error),
    reasoningTokens,
    totalTokens: strictInteger(value.totalTokens, error),
  };
  if (usage.totalTokens !== usage.inputTokens + usage.outputTokens +
      usage.cacheReadTokens + usage.cacheWriteTokens ||
      usage.reasoningTokens > usage.outputTokens) {
    throw new Error(error);
  }
  return usage;
}

function eveRuntimeIdentity(events: unknown[]): {
  provider: string;
  model: string;
  upstreamVersion: string;
} {
  const starts = events.filter((event) =>
    isRecord(event) && event.type === "session.started" && isRecord(event.data) &&
    isRecord(event.data.runtime));
  if (starts.length !== 1) throw new Error("cave_eve_runtime_identity_missing");
  const runtime = (starts[0] as { data: { runtime: Record<string, unknown> } }).data.runtime;
  if (typeof runtime.modelId !== "string" || runtime.modelId.length === 0 ||
      runtime.modelId.startsWith("dynamic:")) {
    throw new Error("cave_eve_runtime_identity_missing");
  }
  const separator = runtime.modelId.indexOf("/");
  if (separator < 1 || separator === runtime.modelId.length - 1 ||
      typeof runtime.eveVersion !== "string" || runtime.eveVersion.length === 0) {
    throw new Error("cave_eve_runtime_identity_missing");
  }
  return {
    provider: runtime.modelId.slice(0, separator),
    model: runtime.modelId.slice(separator + 1),
    upstreamVersion: runtime.eveVersion,
  };
}

function expectedProviderModel(plan: CavePlan): { provider: string; model: string } {
  const separator = plan.model.indexOf("/");
  if (separator < 1 || separator === plan.model.length - 1) {
    throw new Error("cave_harness_model_invalid");
  }
  return { provider: plan.model.slice(0, separator), model: plan.model.slice(separator + 1) };
}

function record(value: unknown, error: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(error);
  return value;
}

function strictInteger(value: unknown, error: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(error);
  return Number(value);
}

function optionalInteger(value: unknown, error: string): number {
  return value === undefined ? 0 : strictInteger(value, error);
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * Read the ACTUALLY-INSTALLED version of a package from its own package.json
 * `import.meta.resolve` is synchronous in Node and locates the
 * real resolved module, so the identity is derived from what is installed — not
 * from a caller-supplied string that could claim a supported version while a
 * different one runs.
 */
function installedPackageVersion(pkg: string): string | undefined {
  const readVersion = (jsonPath: string, requireName: boolean): string | undefined => {
    try {
      const json = JSON.parse(readFileSync(jsonPath, "utf8")) as { name?: unknown; version?: unknown };
      if (requireName && json.name !== pkg) return undefined;
      return typeof json.version === "string" ? json.version : undefined;
    } catch {
      return undefined;
    }
  };
  // Preferred: the package exposes its own package.json (most modern packages).
  try {
    const direct = readVersion(fileURLToPath(import.meta.resolve(`${pkg}/package.json`)), false);
    if (direct !== undefined) return direct;
  } catch {
    // exports map may not expose package.json; fall through to walking up.
  }
  // Fallback: resolve the package entry and walk up to its package.json.
  try {
    let dir = dirname(fileURLToPath(import.meta.resolve(pkg)));
    for (let depth = 0; depth < 12; depth += 1) {
      const version = readVersion(resolvePath(dir, "package.json"), true);
      if (version !== undefined) return version;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // Not resolvable at all.
  }
  return undefined;
}

function assertSupportedUpstream(
  identity: HarnessAdapterIdentity,
  expected: string,
  harness: string,
  pkg: string,
): void {
  // The pin is enforced against the INSTALLED version, and the caller's claimed
  // upstreamVersion must match what is actually installed — a claim alone can no
  // longer authorize execution.
  const installed = installedPackageVersion(pkg);
  if (installed === undefined) {
    throw new Error(`cave_${harness}_upstream_version_unresolvable`);
  }
  if (installed !== expected) {
    throw new Error(`cave_${harness}_upstream_version_unsupported`);
  }
  if (identity.upstreamVersion !== installed) {
    throw new Error(`cave_${harness}_upstream_version_mismatch`);
  }
}

function canonicalRecord(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  let encoded: string;
  try {
    encoded = stableStringify(value);
  } catch {
    throw new Error("cave_harness_wire_contract_invalid");
  }
  const decoded = JSON.parse(encoded) as unknown;
  if (!isRecord(decoded)) throw new Error("cave_harness_wire_contract_invalid");
  return decoded;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactObjectKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index]);
}

function canonicalStringSet(value: readonly string[]): string {
  return stableStringify([...new Set(value)].sort());
}

function snapshotRequest(request: HarnessRequest): Readonly<HarnessRequest> {
  try {
    const { signal, ...serializable } = request;
    const snapshot = deepFreeze(structuredClone(serializable));
    if (signal === undefined) return snapshot;
    if (typeof signal.aborted !== "boolean" || typeof signal.addEventListener !== "function") {
      throw new Error("cave_harness_signal_invalid");
    }
    return Object.freeze({ ...snapshot, signal });
  } catch {
    throw new Error("cave_harness_request_invalid");
  }
}

function snapshotExecution(value: HarnessExecution): Readonly<HarnessExecution> {
  if (!isRecord(value) ||
      !Array.isArray(value.evaluatedTransformIDs) ||
      !Array.isArray(value.appliedTransformIDs)) {
    throw new Error("cave_harness_incomplete_evidence");
  }
  return deepFreeze({
    terminal: value.terminal,
    text: value.text,
    provider: value.provider,
    model: value.model,
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    cacheReadTokens: value.cacheReadTokens,
    cacheWriteTokens: value.cacheWriteTokens,
    reasoningTokens: value.reasoningTokens,
    totalTokens: value.totalTokens,
    costUsd: value.costUsd,
    usageBasis: value.usageBasis,
    priceBasis: value.priceBasis,
    evaluatedTransformIDs: [...value.evaluatedTransformIDs],
    appliedTransformIDs: [...value.appliedTransformIDs],
    recoveryResolved: value.recoveryResolved,
    latencyMs: value.latencyMs,
  });
}

function validateTransformEvidence(
  evidence: Pick<HarnessRequest, "evaluatedTransformIDs" | "appliedTransformIDs" | "recoveryResolved">,
  plan: CavePlan,
): void {
  if (!Array.isArray(evidence.evaluatedTransformIDs) ||
      !Array.isArray(evidence.appliedTransformIDs) ||
      evidence.evaluatedTransformIDs.some((value) => typeof value !== "string" || value.length === 0) ||
      evidence.appliedTransformIDs.some((value) => typeof value !== "string" || value.length === 0) ||
      evidence.recoveryResolved !== true) {
    throw new Error("cave_harness_incomplete_evidence");
  }
  const selected = [...new Set(plan.segment_routes.map((route) => route.transform_id))].sort();
  const evaluated = [...new Set(evidence.evaluatedTransformIDs)].sort();
  const applied = [...new Set(evidence.appliedTransformIDs)].sort();
  if (selected.some((transformID) => !evaluated.includes(transformID))) {
    throw new Error("cave_harness_transform_not_evaluated");
  }
  if (evaluated.some((transformID) => !selected.includes(transformID)) ||
      applied.some((transformID) => !selected.includes(transformID))) {
    throw new Error("cave_harness_unknown_transform");
  }
}

function validateExecution(
  execution: HarnessExecution,
  plan: CavePlan,
  accountingStartedAt: Date,
  accountingFinishedAt: Date,
): void {
  const [provider, ...modelParts] = plan.model.split("/");
  const model = modelParts.join("/");
  try {
    const startFingerprint = catalogPriceFingerprint(
      provider ?? "",
      model,
      accountingStartedAt,
    );
    const finishFingerprint = catalogPriceFingerprint(
      provider ?? "",
      model,
      accountingFinishedAt,
    );
    if (startFingerprint === undefined || startFingerprint !== finishFingerprint) {
      throw new Error("cave_provider_price_window_changed");
    }
    validateProviderUsage(execution, {
      expected: { provider: provider ?? "", model },
      reportedCostUsd: execution.costUsd,
      requirePriced: true,
      accountingAt: accountingStartedAt,
    });
    validateProviderUsage(execution, {
      expected: { provider: provider ?? "", model },
      reportedCostUsd: execution.costUsd,
      requirePriced: true,
      accountingAt: accountingFinishedAt,
    });
  } catch {
    throw new Error("cave_harness_incomplete_evidence");
  }
  if (execution.terminal !== true || typeof execution.text !== "string" ||
      execution.text.length === 0 ||
      execution.usageBasis !== "provider_reported" ||
      execution.priceBasis !== "public_catalog" ||
      !Number.isFinite(execution.latencyMs) || execution.latencyMs < 0 ||
      execution.recoveryResolved !== true) {
    throw new Error("cave_harness_incomplete_evidence");
  }
  validateTransformEvidence(execution, plan);
}
