/**
 * Provider-wire transport: Caveman optimizations at the `fetch` seam.
 *
 * Every framework in this repo's adapter set (Vercel AI SDK, Mastra, OpenAI
 * Agents, LangGraph, Cloudflare Agents, …) lets its provider client take a
 * custom `fetch`. The cache planner already works on provider-native JSON
 * bodies, and `budget.ts` already reserves and settles per call, so both are
 * portable here without a single line of per-framework code: this layer scales
 * by PROVIDER, not by framework.
 *
 * What lives here: the outgoing request ceiling (reserve/clamp/deny), exact
 * provider-reported usage, and provider-native cache hints.
 *
 * What deliberately does NOT live here: compaction and model routing. Both
 * rewrite what the framework believes it sent, so applying them at the wire
 * would desync framework-owned message state from the transcript the model
 * actually saw. They stay on the adapter `modelBoundary` seam.
 *
 * This transport makes no savings claim of any kind. It mints nothing.
 */
import {
  BudgetMeter,
  inputTokenCeiling,
  normalizeRunBudget,
  planCall,
  type BudgetReservation,
  type RunBudget,
} from "./budget.js";
import { catalogCost } from "./catalog.js";
import { CachePlanEngine } from "./cache-planner/engine.js";
import type { CachePlan } from "./cache-planner/types.js";
import { optimizeNativeRequest } from "./cache-planner/wires.js";
import { sha256 } from "./context-ir.js";
import { defineModelUsage, type ModelUsage } from "./model-usage.js";

/** Largest response body scanned for usage. Past it, usage stays unknown. */
export const WIRE_MAX_USAGE_SCAN_BYTES = 8 * 1024 * 1024;

/**
 * How much of the cache planner may reach a live provider.
 *
 * `"gated"` mirrors `runtime.ts` exactly: only cache grammars proven against a
 * live provider leave the SDK, which today is the OpenAI affinity routing key
 * alone. Anthropic and Bedrock splices are byte-parity-tested against the Go
 * engine's fixtures but have never been sent to a live endpoint from this SDK
 * (#225), so they are held back here for the same reason.
 *
 * `"all"` releases every grammar the planner selects. It is an explicit,
 * documented opt-in to unproven-live behavior, never a default.
 */
export type WireCacheScope = "off" | "gated" | "all";

export interface WireCacheDecision {
  readonly provider: string;
  readonly model: string;
  readonly endpoint: string;
  readonly applied: boolean;
  readonly reason: string;
  readonly optimizerIds: readonly string[];
  readonly plan: CachePlan;
  /** True when the planner chose to act but {@link WireCacheScope} held it. */
  readonly heldByScope: boolean;
}

export interface CavemanTransportOptions {
  /**
   * Hard ceiling on this transport's spend. Denomination is caller-declared and
   * fails closed: a USD budget on a model the public catalog cannot price stops
   * the call rather than spending an unmeasurable amount.
   *
   * The wire cannot see which credential pays, so it cannot tell a metered API
   * key from a subscription. `maxTokens` is the honest default for portable use;
   * `maxUsd` asserts that this transport's key is billed in dollars.
   */
  readonly budget?: RunBudget;
  /** Defaults to `"gated"`. */
  readonly cache?: WireCacheScope;
  /** Cache scope id. Requests sharing a prefix must share it. */
  readonly scope?: string;
  /** Exact provider-reported usage, once per completed call. */
  readonly onModelUsage?: (usage: ModelUsage) => void;
  /** Every cache decision, applied or not. Diagnostic only. */
  readonly onCacheDecision?: (decision: WireCacheDecision) => void;
  /** Underlying transport. Defaults to `globalThis.fetch`. */
  readonly fetch?: typeof globalThis.fetch;
}

export interface CavemanTransport {
  /** Pass to any provider client that accepts a custom fetch. */
  readonly fetch: typeof globalThis.fetch;
  /** The live meter when a budget was configured. Read-only in practice. */
  readonly meter: BudgetMeter | undefined;
}

interface WireTarget {
  readonly provider: string;
  readonly endpoint: string;
  readonly outputField: string;
}

/**
 * Host and path together, never path alone: the planner's marker rules are
 * provider-specific, so a wrong provider guess would splice the wrong keys into
 * a body we do not understand. An unrecognized target passes straight through.
 */
function resolveTarget(url: URL): WireTarget | undefined {
  const host = url.hostname.toLowerCase();
  const path = url.pathname;
  if (host === "api.anthropic.com" || host.endsWith(".anthropic.com")) {
    if (path.endsWith("/v1/messages")) {
      return { provider: "anthropic", endpoint: "/v1/messages", outputField: "max_tokens" };
    }
    return undefined;
  }
  if (host === "api.openai.com" || host.endsWith(".openai.com")) {
    if (path.endsWith("/v1/chat/completions")) {
      return {
        provider: "openai",
        endpoint: "/v1/chat/completions",
        outputField: "max_completion_tokens",
      };
    }
    if (path.endsWith("/v1/responses")) {
      return { provider: "openai", endpoint: "/v1/responses", outputField: "max_output_tokens" };
    }
    return undefined;
  }
  // ponytail: anthropic + openai only. Bedrock carries model and region in the
  // URL and needs SigV4-aware re-signing after any body edit; add it when a
  // Bedrock user asks.
  return undefined;
}

export function createCavemanTransport(
  options: CavemanTransportOptions = {},
): CavemanTransport {
  const transport = options.fetch ?? globalThis.fetch;
  const scope = options.scope ?? "caveman-wire";
  const cacheScope = options.cache ?? "gated";
  const meter = options.budget === undefined
    ? undefined
    : new BudgetMeter(normalizeRunBudget(options.budget));
  const engine = cacheScope === "off" ? undefined : new CachePlanEngine();

  const wireFetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input as RequestInfo, init);
    const target = requestTarget(request);
    if (target === undefined) return transport(request);

    let body: Record<string, unknown>;
    let text: string;
    try {
      text = await request.clone().text();
      const parsed: unknown = JSON.parse(text);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return transport(request);
      }
      body = parsed as Record<string, unknown>;
    } catch {
      // A body this layer cannot read is a body it must not edit or meter.
      return transport(request);
    }

    const model = typeof body["model"] === "string" ? body["model"] : undefined;
    if (model === undefined) return transport(request);

    const reservation = reserve(meter, target, model, text, body);
    text = clampOutput(text, body, target.outputField, reservation);

    if (engine !== undefined) {
      text = applyCacheHints({
        engine,
        scope,
        cacheScope,
        target,
        model,
        body,
        text,
        onCacheDecision: options.onCacheDecision,
      });
    }

    let response: Response;
    try {
      response = await transport(new Request(request, { body: text }));
    } catch (error) {
      // Nothing was billed for a request that never landed.
      if (reservation !== undefined) meter?.cancel(reservation);
      throw error;
    }

    return meterResponse({
      response,
      meter,
      reservation,
      provider: target.provider,
      model,
      onModelUsage: options.onModelUsage,
    });
  };

  return Object.freeze({ fetch: wireFetch, meter });
}

function requestTarget(request: Request): WireTarget | undefined {
  if (request.method.toUpperCase() !== "POST") return undefined;
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return undefined;
  }
  return resolveTarget(url);
}

/**
 * Reserve this call's worst case before it leaves. The input bound is a UTF-8
 * byte count, which over-reserves by roughly 3-4x but can never come in low —
 * the same trade `budget.ts` documents for the native runtime.
 */
function reserve(
  meter: BudgetMeter | undefined,
  target: WireTarget,
  model: string,
  text: string,
  body: Record<string, unknown>,
): BudgetReservation | undefined {
  if (meter === undefined) return undefined;
  const declared = body[target.outputField];
  const outputTokenCap = Number.isSafeInteger(declared) && (declared as number) > 0
    ? declared as number
    : meter.outputFloorTokens;
  const plan = planCall(meter, {
    provider: target.provider,
    model,
    inputTokenCeiling: inputTokenCeiling(
      Buffer.byteLength(text, "utf8"),
      messageCount(body),
      0,
    ),
    outputTokenCap,
  }, false);
  if (plan.action !== "proceed") {
    throw new Error(
      plan.action === "stop"
        ? `cave_wire_budget_exhausted:${plan.reason}`
        : "cave_wire_budget_exhausted",
    );
  }
  return plan.reservation;
}

function messageCount(body: Record<string, unknown>): number {
  for (const key of ["messages", "input"]) {
    const value = body[key];
    if (Array.isArray(value)) return value.length;
  }
  return 0;
}

/**
 * Write back the clamped output allowance when the meter could not fund the
 * full one. Re-serializing the whole body here is safe because the cache
 * planner has not run yet: its splices are byte-exact and must be last.
 */
function clampOutput(
  text: string,
  body: Record<string, unknown>,
  field: string,
  reservation: BudgetReservation | undefined,
): string {
  if (reservation === undefined) return text;
  if (body[field] === reservation.outputTokenCap) return text;
  return JSON.stringify({ ...body, [field]: reservation.outputTokenCap });
}

function applyCacheHints(input: {
  engine: CachePlanEngine;
  scope: string;
  cacheScope: WireCacheScope;
  target: WireTarget;
  model: string;
  body: Record<string, unknown>;
  text: string;
  onCacheDecision: CavemanTransportOptions["onCacheDecision"];
}): string {
  try {
    const result = optimizeNativeRequest(input.engine, {
      scope: input.scope,
      // The epoch carries the stable slice's digest, so changed instructions or
      // tools open a NEW epoch instead of permanently tripping prefix drift.
      epoch: stablePrefixEpoch(input.body),
      provider: input.target.provider,
      model: input.model,
      endpoint: input.target.endpoint,
      body: input.text,
      runtimeMode: "optimize",
      prefixTokens: 0,
    });
    const release = input.cacheScope === "all" || provenLive(result.optimizerIds, result.plan);
    input.onCacheDecision?.(Object.freeze({
      provider: input.target.provider,
      model: input.model,
      endpoint: input.target.endpoint,
      applied: result.applied && release,
      reason: result.reason,
      optimizerIds: Object.freeze([...result.optimizerIds]),
      plan: result.plan,
      heldByScope: result.applied && !release,
    }));
    return result.applied && release ? result.body : input.text;
  } catch {
    // Any planning uncertainty sends the original bytes. Never a partial edit.
    return input.text;
  }
}

/**
 * The #225 live-path gate, identical to `runtime.ts`: today exactly the OpenAI
 * affinity routing key is proven against a live provider.
 */
function provenLive(optimizerIds: readonly string[], plan: CachePlan): boolean {
  return plan.mode === "affinity" &&
    optimizerIds.length === 1 &&
    optimizerIds[0] === "openai-prompt-cache-key";
}

function stablePrefixEpoch(body: Record<string, unknown>): string {
  const stable = ["system", "tools", "instructions", "toolConfig"]
    .map((key) => body[key]);
  return sha256(JSON.stringify(stable)).slice(0, 32);
}

async function meterResponse(input: {
  response: Response;
  meter: BudgetMeter | undefined;
  reservation: BudgetReservation | undefined;
  provider: string;
  model: string;
  onModelUsage: CavemanTransportOptions["onModelUsage"];
}): Promise<Response> {
  const { response, meter, reservation } = input;
  const settle = (raw: RawUsage | undefined): void => {
    const measured = buildUsage(raw, input.provider, input.model);
    if (measured !== undefined) input.onModelUsage?.(measured.usage);
    if (reservation === undefined || meter === undefined) return;
    // Unknown usage settles at the FULL reserve, never at zero: a call whose
    // cost cannot be measured has not been shown to be cheap.
    const spend = meter.denomination === "tokens"
      ? measured?.usage.totalTokens ?? undefined
      : measured?.usd;
    meter.settle(reservation, spend ?? reservation.amount);
  };

  if (!response.ok || response.body === null) {
    settle(undefined);
    return response;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    let raw: RawUsage | undefined;
    try {
      raw = collectUsage(await response.clone().text());
    } catch {
      raw = undefined;
    }
    settle(raw);
    return response;
  }

  // Tee so the caller's stream stays pull-driven and untouched; the scanning
  // branch is drained eagerly and only ever reads usage fields out of it.
  const [caller, scan] = response.body.tee();
  void scanStream(scan).then(settle, () => settle(undefined));
  return new Response(caller, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function scanStream(stream: ReadableStream<Uint8Array>): Promise<RawUsage | undefined> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let bytes = 0;
  try {
    for (;;) {
      const read = await reader.read();
      if (read.done) break;
      bytes += read.value.byteLength;
      if (bytes > WIRE_MAX_USAGE_SCAN_BYTES) return undefined;
      buffered += decoder.decode(read.value, { stream: true });
    }
    buffered += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return collectUsage(buffered);
}

interface RawUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
}

/**
 * Merge every `usage` object in a body or SSE stream. Anthropic splits one
 * call's usage across `message_start` (input, cache) and `message_delta`
 * (output); OpenAI reports it once in a final chunk, and only when the caller
 * asked for it. A field nobody reported stays `null`, never zero.
 */
function collectUsage(text: string): RawUsage | undefined {
  const merged: RawUsage = {
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
  };
  let found = false;
  for (const payload of jsonPayloads(text)) {
    for (const usage of usageObjects(payload)) {
      found = mergeUsage(merged, usage) || found;
    }
  }
  return found ? merged : undefined;
}

function* jsonPayloads(text: string): Generator<unknown> {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{")) {
    try {
      yield JSON.parse(text) as unknown;
    } catch {
      // Fall through: a truncated body yields nothing rather than throwing.
    }
    return;
  }
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "" || data === "[DONE]") continue;
    try {
      yield JSON.parse(data) as unknown;
    } catch {
      continue;
    }
  }
}

function* usageObjects(payload: unknown): Generator<Record<string, unknown>> {
  if (payload === null || typeof payload !== "object") return;
  const record = payload as Record<string, unknown>;
  for (const key of ["usage", "message", "response"]) {
    const value = record[key];
    if (value === null || typeof value !== "object") continue;
    if (key === "usage") {
      yield value as Record<string, unknown>;
      continue;
    }
    yield* usageObjects(value);
  }
}

function mergeUsage(into: RawUsage, usage: Record<string, unknown>): boolean {
  const details = (key: string, field: string): number | null =>
    nested(usage[key], field);
  const candidates: RawUsage = {
    inputTokens: firstCount(usage["input_tokens"], usage["prompt_tokens"]),
    outputTokens: firstCount(usage["output_tokens"], usage["completion_tokens"]),
    cacheReadTokens: firstCount(
      usage["cache_read_input_tokens"],
      details("prompt_tokens_details", "cached_tokens"),
      details("input_tokens_details", "cached_tokens"),
    ),
    cacheWriteTokens: count(usage["cache_creation_input_tokens"]),
    reasoningTokens: firstCount(
      details("completion_tokens_details", "reasoning_tokens"),
      details("output_tokens_details", "reasoning_tokens"),
    ),
  };
  let changed = false;
  for (const field of Object.keys(candidates) as (keyof RawUsage)[]) {
    const value = candidates[field];
    if (value === null) continue;
    // Later events refine earlier ones (Anthropic's output count arrives last).
    into[field] = value;
    changed = true;
  }
  return changed;
}

function nested(value: unknown, field: string): number | null {
  if (value === null || typeof value !== "object") return null;
  return count((value as Record<string, unknown>)[field]);
}

function firstCount(...values: readonly unknown[]): number | null {
  for (const value of values) {
    const parsed = count(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function count(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}

/**
 * OpenAI reports prompt tokens INCLUSIVE of cached tokens while this contract
 * (and Anthropic) treat them as disjoint classes. Subtracting keeps the four
 * classes non-overlapping so `totalTokens` is a real sum.
 *
 * `usd` is carried beside the record rather than inside it because
 * `ModelUsage.cost` may only be priced when EVERY count is known, reasoning
 * included. Anthropic never breaks the reasoning split out, so its record is
 * honestly `unknown` while the meter can still settle on an exact figure — see
 * {@link priceWithUnknownReasoningSplit}.
 */
function buildUsage(
  raw: RawUsage | undefined,
  provider: string,
  model: string,
): { usage: ModelUsage; usd: number | undefined } | undefined {
  if (raw === undefined) return undefined;
  const cacheRead = raw.cacheReadTokens;
  const inputTokens = provider === "openai" && raw.inputTokens !== null && cacheRead !== null
    ? Math.max(0, raw.inputTokens - cacheRead)
    : raw.inputTokens;
  // OpenAI has no cache-WRITE class at all (its catalog rate is `null`, and its
  // caching is affinity-based), so an absent count there is a provider fact
  // rather than a missing measurement. This is the only field defaulted to zero
  // anywhere in this module; every other absence stays `null`.
  const cacheWrite = provider === "openai"
    ? raw.cacheWriteTokens ?? 0
    : raw.cacheWriteTokens;
  // Reasoning is a SUBSET of output, so the four disjoint classes sum to an
  // exact total even when no provider broke the reasoning split out.
  const billable = inputTokens !== null && raw.outputTokens !== null &&
    cacheRead !== null && cacheWrite !== null;
  const totalTokens = billable
    ? inputTokens! + raw.outputTokens! + cacheRead! + cacheWrite!
    : null;
  const priced = billable
    ? priceWithUnknownReasoningSplit({
      provider,
      model,
      inputTokens: inputTokens!,
      outputTokens: raw.outputTokens!,
      cacheReadTokens: cacheRead!,
      cacheWriteTokens: cacheWrite!,
    }, raw.reasoningTokens)
    : undefined;
  const complete = billable && raw.reasoningTokens !== null;
  try {
    const usage = defineModelUsage({
      schemaVersion: 1,
      provider,
      model,
      inputTokens,
      outputTokens: raw.outputTokens,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      reasoningTokens: raw.reasoningTokens,
      totalTokens,
      // The contract prices a call only when every count is known. An
      // incomplete record stays explicitly unknown rather than implying a
      // reasoning count nobody reported.
      cost: !complete
        ? { status: "unknown" }
        : priced?.priced
        ? { status: "estimated", basis: "public_catalog", usd: priced.usd }
        : { status: "unpriced" },
    });
    return { usage, usd: priced?.priced === true ? priced.usd : undefined };
  } catch {
    return undefined;
  }
}


/**
 * Price a call whose reasoning split the provider did not report.
 *
 * Reasoning is a subset of output, so the unknown split can only move the cost
 * between the output rate and the reasoning rate. Pricing both extremes settles
 * it without a special case: equal totals mean the split is irrelevant and the
 * figure is exact, and any difference leaves the cost honestly unknown rather
 * than picking an end of the bracket.
 */
function priceWithUnknownReasoningSplit(
  usage: Omit<Parameters<typeof catalogCost>[0], "reasoningTokens">,
  reasoningTokens: number | null,
): { priced: boolean; usd: number } | undefined {
  if (reasoningTokens !== null) {
    return catalogCost({ ...usage, reasoningTokens });
  }
  const none = catalogCost({ ...usage, reasoningTokens: 0 });
  const all = catalogCost({ ...usage, reasoningTokens: usage.outputTokens });
  if (!none.priced || !all.priced || none.usd !== all.usd) return undefined;
  return none;
}
