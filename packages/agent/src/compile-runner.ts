import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { Value } from "typebox/value";
import { catalogCost } from "./catalog.js";
import { sha256, stableStringify, type ContextIR } from "./context-ir.js";
import type { AgentDefinition } from "./index.js";
import type { CavePlan, CompileInput, RunEvidence } from "./build.js";
import type { EvalDefinition, QualityGrader } from "./primitives.js";
import {
  runAgentInternal,
  createConversation,
  validateSandboxCredentialEnv,
  type ConversationState,
} from "./runtime.js";

export function createNativePiEvalRunner(input: {
  rootDir: string;
  entryPath: string;
  definition: AgentDefinition;
  sandboxConformance: boolean;
  privacyConformance: boolean;
}): CompileInput["runner"] {
  const conversations = new Map<string, ConversationState>();
  return ({ plan, eval: fixture, seed, maxCostUsd, signal }) => runNativePiFixture({
    ...input,
    plan,
    fixture,
    seed,
    conversations,
    maxCostUsd,
    signal,
  });
}

export async function runNativePiFixture(input: {
  rootDir: string;
  entryPath: string;
  definition: AgentDefinition;
  plan: CavePlan;
  fixture: EvalDefinition;
  seed: number;
  sandboxConformance: boolean;
  privacyConformance: boolean;
  conversations: Map<string, ConversationState>;
  maxCostUsd: number;
  signal: AbortSignal;
}): Promise<RunEvidence> {
  try {
    const definitionModel = input.definition.model;
    const selectedModel = typeof definitionModel === "object" && "provider" in definitionModel &&
      "id" in definitionModel &&
      `${definitionModel.provider}/${definitionModel.id}` === input.plan.model
      ? definitionModel
      : input.plan.model;
    const selected = {
      ...input.definition,
      model: selectedModel,
      reasoning: runtimeReasoning(input.plan.reasoning),
      // Compiler evidence always runs tool closures in Caveman's contained
      // worker. Fixture mode gets network/child/credential denial defaults;
      // live mode must name an explicit sandbox profile below.
      sandbox: "required",
    } as AgentDefinition;
    const conversationKey = `${input.plan.plan_id}\u0000${input.fixture.id}\u0000${input.seed}`;
    const conversation = input.conversations.get(conversationKey) ?? createConversation();
    input.conversations.set(conversationKey, conversation);
    const result = await runAgentInternal(selected, fixtureInput(input.fixture.input), {
      rootDir: input.rootDir,
      entryPath: input.entryPath,
      candidatePlan: input.plan,
      sessionId: `compile:${sha256(input.plan.plan_id).slice(0, 16)}:${sha256(
        `${input.fixture.id}\u0000${input.seed}`,
      ).slice(0, 16)}`,
      conversation,
      maxCostUsd: input.maxCostUsd,
      signal: input.signal,
      ...(input.fixture.tools.mode === "live" ? {
        sandboxProfile: await loadEvalSandboxProfile(input.rootDir, input.fixture),
      } : {}),
    });
    const priced = catalogCost(result);
    const successfulToolCalls = result.receipt.tools
      .filter((tool) => tool.calls > tool.errors)
      .map((tool) => tool.name);
    const graders = input.fixture.quality.map((grader) => ({
      type: grader.type,
      passed: grade(grader, result.text, successfulToolCalls),
    }));
    return {
      terminal: true,
      provider: result.provider,
      model: result.model,
      usage_basis: result.usageBasis === "provider_reported" ? "provider_reported" : "missing",
      price_basis: result.priceBasis,
      catalog_cost_usd: priced.usd,
      input_tokens: result.inputTokens,
      output_tokens: result.outputTokens,
      reasoning_tokens: result.reasoningTokens,
      quality_score: graders.filter((item) => item.passed).length / graders.length,
      graders,
      latency_ms: result.latencyMs,
      provider_visible_tokens: result.inputTokens + result.cacheReadTokens + result.cacheWriteTokens,
      cache_prefix_sha256: result.cachePrefixSHA256,
      cache_boundary_known: result.cacheBoundaryKnown,
      cache_read_tokens: result.cacheReadTokens,
      cache_write_tokens: result.cacheWriteTokens,
      cache_bust: result.cacheBust,
      error: result.stopReason !== "complete" || result.capBreached,
      recovery_resolved: result.recoveryResolved && result.transformFailures.length === 0,
      privacy_passed: input.privacyConformance && contentBlindRunEvidence(result, input.fixture),
      sandbox_passed: input.sandboxConformance,
      unknown_transform: input.plan.segment_routes.some((route) =>
        !result.evaluatedTransformIDs.includes(route.transform_id)),
      output_digest: sha256(result.text),
    };
  } catch (error) {
    throw new Error("cave_fixture_terminal_evidence_missing", { cause: error });
  }
}

export async function loadEvalSandboxProfile(
  root: string,
  fixture: EvalDefinition,
): Promise<{
  network: boolean;
  childProcess: boolean;
  credentialEnv: readonly string[];
}> {
  const path = fixture.tools.sandbox;
  if (!path) throw new Error("cave_live_eval_sandbox_profile_missing");
  const fullPath = resolve(root, path);
  const relativePath = relative(root, fullPath);
  if (relativePath === ".." || relativePath.startsWith("../") ||
      relativePath.startsWith("..\\") || isAbsolute(relativePath)) {
    throw new Error("cave_live_eval_sandbox_profile_escapes_root");
  }
  const canonicalRoot = await realpath(root);
  const canonicalPath = await realpath(fullPath);
  const canonicalRelative = relative(canonicalRoot, canonicalPath);
  if (canonicalRelative === ".." || canonicalRelative.startsWith("../") ||
      canonicalRelative.startsWith("..\\") || isAbsolute(canonicalRelative)) {
    throw new Error("cave_live_eval_sandbox_profile_escapes_root");
  }
  const parsedValue = JSON.parse(await readBoundedSandboxProfile(canonicalPath)) as unknown;
  if (!isRecord(parsedValue)) throw new Error("cave_live_eval_sandbox_profile_invalid");
  const parsed = parsedValue;
  const keys = Object.keys(parsed).sort();
  const expected = ["child_process", "credential_env", "network", "schema_version"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index]) ||
      parsed.schema_version !== 1 || typeof parsed.network !== "boolean" ||
      typeof parsed.child_process !== "boolean" || !Array.isArray(parsed.credential_env) ||
      parsed.credential_env.some((name) => typeof name !== "string" ||
        !/^[A-Z][A-Z0-9_]{0,127}$/.test(name))) {
    throw new Error("cave_live_eval_sandbox_profile_invalid");
  }
  validateSandboxCredentialEnv(parsed.credential_env as string[]);
  return {
    network: parsed.network,
    childProcess: parsed.child_process,
    credentialEnv: parsed.credential_env as string[],
  };
}

const MAX_SANDBOX_PROFILE_BYTES = 64 * 1024;

async function readBoundedSandboxProfile(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("cave_live_eval_sandbox_profile_not_regular_file");
    if (metadata.size > MAX_SANDBOX_PROFILE_BYTES) {
      throw new Error("cave_live_eval_sandbox_profile_too_large");
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    while (true) {
      const buffer = Buffer.allocUnsafe(Math.min(
        16 * 1024,
        MAX_SANDBOX_PROFILE_BYTES + 1 - bytes,
      ));
      const read = await handle.read(buffer, 0, buffer.length, null);
      if (read.bytesRead === 0) break;
      bytes += read.bytesRead;
      if (bytes > MAX_SANDBOX_PROFILE_BYTES) {
        throw new Error("cave_live_eval_sandbox_profile_too_large");
      }
      chunks.push(buffer.subarray(0, read.bytesRead));
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes));
    } catch (error) {
      throw new Error("cave_live_eval_sandbox_profile_utf8_invalid", { cause: error });
    }
  } finally {
    await handle.close();
  }
}

export function contextIRIsContentBlind(ir: ContextIR): boolean {
  const allowed = new Set([
    "id", "kind", "stability", "safety", "priority", "recovery", "cacheRegion",
    "privacy", "opaque", "ttlTurns", "provenanceDigest", "tokenCount", "bodyHandle",
  ]);
  return ir.segments.every((segment) =>
    Object.keys(segment).every((key) => allowed.has(key)) &&
    /^cave_local_sha256:[0-9a-f]{64}$/.test(segment.bodyHandle) &&
    /^[0-9a-f]{64}$/.test(segment.provenanceDigest));
}

function contentBlindRunEvidence(
  result: Awaited<ReturnType<typeof runAgentInternal>>,
  fixture: EvalDefinition,
): boolean {
  const exported = stableStringify({
    run_id: sha256(result.runId),
    agent_id: result.agentId,
    context_bill: result.contextBill,
    usage_basis: result.usageBasis,
    usage: {
      input: result.inputTokens,
      output: result.outputTokens,
      cache_read: result.cacheReadTokens,
      cache_write: result.cacheWriteTokens,
      reasoning_basis: result.reasoningUsageBasis,
      reasoning: result.reasoningTokens,
      cost_usd: result.costUsd,
    },
    provider: result.provider,
    model: result.model,
    latency_ms: result.latencyMs,
    tool_names: result.toolCalls,
    output_digest: sha256(result.text),
  });
  const forbidden = [fixtureInput(fixture.input), result.text]
    .filter((value) => value.length >= 4);
  return forbidden.every((value) => !exported.includes(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function grade(grader: QualityGrader, text: string, toolCalls: string[]): boolean {
  if (grader.type === "contains") return grader.fragments.every((fragment) => text.includes(fragment));
  if (grader.type === "tool_called") return grader.tools.every((tool) => toolCalls.includes(tool));
  if (grader.type === "exact_match") return text === grader.expected;
  if (grader.type === "json_schema") {
    try {
      return Value.Check(grader.schema, JSON.parse(text));
    } catch {
      return false;
    }
  }
  return false;
}

function runtimeReasoning(value: CavePlan["reasoning"]): AgentDefinition["reasoning"] {
  return value === "none" ? "off" : value;
}

function fixtureInput(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
