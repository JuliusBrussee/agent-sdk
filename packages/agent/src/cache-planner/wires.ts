// TS port of the provider-native wire compilers in public/cacheengine
// (native.go, openai.go, wire_anthropic_bedrock.go, builtins.go).
//
// Byte discipline, pinned by planner-fixtures/wire.json: Anthropic and OpenAI
// wires SPLICE provider-native cache hints into the original body without
// re-serializing it; the Bedrock wire reserializes as Go's sorted-key
// json.Marshal does (goMarshal below reproduces that byte-for-byte). Every
// unsupported or unsafe path returns the original bytes; applied results are
// at most "inferred" and verified dollars are always zero.
import {
  CachePlanEngine,
  appendFrame,
  normalizedProfile,
  validIdentity,
} from "./engine.js";
import * as splice from "./jsonsplice.js";
import {
  resolveAnthropicProfile,
  resolveBedrockProfile,
  resolveOpenAIProfile,
} from "./profiles.js";
import type {
  CacheAttribution,
  CachePlan,
  CachePlanProfile,
  NativeCacheRequest,
  NativeCacheResult,
} from "./types.js";
import {
  AnthropicRollingOptimizerID,
  AnthropicStableOptimizerID,
  BedrockCacheOptimizerID,
  BedrockRollingOptimizerID,
  OpenAIExplicitOptimizerID,
  OpenAIKeyOptimizerID,
  ReasonAffinityFallback,
  ReasonApplied,
  ReasonCallerManaged,
  ReasonMalformedRequest,
  ReasonNoStablePrefix,
  ReasonNonPAYG,
  ReasonProfileMismatch,
  ReasonRecordMode,
  ReasonTransformUnavailable,
  ReasonUnsupported,
} from "./types.js";

type CallerMarker = (path: readonly string[], key: string) => boolean;

interface MarkerRule {
  key: string;
  /** Object paths where the key is a caller-managed cache marker; [] = root. */
  paths: readonly (readonly string[])[];
}

interface ProfileContract {
  mode: string;
  attribution: string;
  maxBreakpoints: number;
  ttlSeconds: number;
  rolling: boolean;
  routingKey: boolean;
  optimizerId: string;
}

interface Compilation {
  body: string;
  optimizerIds: string[];
}

interface BuiltinDefinition {
  provider: string;
  endpoints: ReadonlySet<string>;
  bodyModelRequired: boolean;
  stableFields: readonly string[];
  stableSequence: string;
  stableSequences?: Readonly<Record<string, string>>;
  markerRules: readonly MarkerRule[];
  resolveProfile: (request: NativeCacheRequest) => CachePlanProfile | undefined;
  contracts: readonly ProfileContract[];
  compile: (request: NativeCacheRequest, plan: CachePlan, profile: CachePlanProfile) => Compilation;
  classify?: (profile: CachePlanProfile, optimizerIds: readonly string[]) =>
    { attribution?: CacheAttribution; reason?: string };
}

const BUILTINS: Readonly<Record<string, BuiltinDefinition>> = {
  anthropic: {
    provider: "anthropic",
    endpoints: new Set(["/v1/messages"]),
    bodyModelRequired: true,
    stableFields: ["tools", "system"],
    stableSequence: "messages",
    markerRules: [{
      key: "cache_control",
      paths: [[], ["tools", "*"], ["system", "*"], ["messages", "*", "content", "*"]],
    }],
    resolveProfile: resolveAnthropicProfile,
    contracts: [{
      mode: "explicit", attribution: "causal", maxBreakpoints: 4, ttlSeconds: 300,
      rolling: true, routingKey: false, optimizerId: AnthropicStableOptimizerID,
    }],
    compile: compileAnthropic,
  },
  openai: {
    provider: "openai",
    endpoints: new Set(["/v1/chat/completions", "/v1/responses"]),
    bodyModelRequired: true,
    stableFields: ["tools", "instructions"],
    stableSequence: "messages",
    stableSequences: { "/v1/responses": "input" },
    markerRules: [
      { key: "prompt_cache_key", paths: [[]] },
      { key: "prompt_cache_options", paths: [[]] },
      {
        key: "prompt_cache_breakpoint",
        paths: [["messages", "*", "content", "*"], ["input", "*", "content", "*"]],
      },
    ],
    resolveProfile: resolveOpenAIProfile,
    contracts: [
      {
        mode: "explicit", attribution: "causal", maxBreakpoints: 4, ttlSeconds: 1800,
        rolling: true, routingKey: true, optimizerId: OpenAIExplicitOptimizerID,
      },
      {
        mode: "affinity", attribution: "affinity", maxBreakpoints: 1, ttlSeconds: 300,
        rolling: true, routingKey: true, optimizerId: OpenAIKeyOptimizerID,
      },
    ],
    compile: compileOpenAI,
    classify: classifyOpenAICompilation,
  },
  bedrock: {
    provider: "bedrock",
    endpoints: new Set(["converse", "converse-stream", "invoke", "invoke-with-response-stream"]),
    bodyModelRequired: false,
    stableFields: ["toolConfig", "system"],
    stableSequence: "messages",
    markerRules: [
      {
        key: "cachePoint",
        paths: [["system", "*"], ["messages", "*", "content", "*"], ["toolConfig", "tools", "*"]],
      },
      {
        key: "cache_control",
        paths: [["system", "*"], ["messages", "*", "content", "*"], ["tools", "*"]],
      },
    ],
    resolveProfile: resolveBedrockProfile,
    contracts: [{
      mode: "explicit", attribution: "causal", maxBreakpoints: 4, ttlSeconds: 300,
      rolling: true, routingKey: false, optimizerId: BedrockCacheOptimizerID,
    }],
    compile: compileBedrock,
  },
};

/**
 * Applies provider-native cache metadata or returns the original body on every
 * unsupported or unsafe path. Makes no network call and mints nothing.
 */
export function optimizeNativeRequest(
  engine: CachePlanEngine,
  request: NativeCacheRequest,
): NativeCacheResult {
  if (Buffer.byteLength(request.body, "utf8") > engine.maxRequestBytes) {
    throw new Error("cache planner: request exceeds configured byte limit");
  }
  const unsupported: CachePlanProfile = normalizedProfile({ id: "unsupported", mode: "unsupported" });
  unsupported.attribution = "none";
  const result: NativeCacheResult = {
    body: request.body,
    applied: false,
    decision: "pass_through",
    reason: ReasonUnsupported,
    optimizerIds: [],
    profile: unsupported,
    plan: {
      decision: "pass_through",
      reason: ReasonUnsupported,
      profile_id: unsupported.id,
      mode: unsupported.mode,
      attribution: "none",
      key_shard: 0,
      key_shard_count: 1,
      expected_net_input_rate_units: 0,
      economics_basis: "unavailable",
    },
    claimBasis: "none",
    verifiedSavingsUsd: 0,
  };
  if (!validNativeIdentity(request)) {
    result.reason = ReasonMalformedRequest;
    return result;
  }
  if ((request.runtimeMode ?? "").trim().toLowerCase() === "record") {
    result.reason = ReasonRecordMode;
    return result;
  }
  const authMode = request.authMode ?? "";
  if (authMode !== "" && authMode.trim().toLowerCase() !== "payg") {
    result.reason = ReasonNonPAYG;
    return result;
  }
  if (request.body.length === 0) {
    result.reason = ReasonMalformedRequest;
    return result;
  }
  const providerName = request.provider.toLowerCase().trim();
  const builtin = BUILTINS[providerName];
  if (builtin !== undefined &&
      ((request.model ?? "") === "" || (request.endpoint ?? "") === "")) {
    result.reason = ReasonMalformedRequest;
    return result;
  }
  if (builtin !== undefined && !builtin.endpoints.has(request.endpoint!)) return result;
  // Unknown providers still get the unique-JSON-object inspection (no caller
  // markers), exactly like Go: a malformed body is malformed_request, not
  // unsupported.
  const inspected = inspectUniqueJSONObject(
    request.body,
    builtin === undefined ? undefined : markerFor(builtin.markerRules),
  );
  if (!inspected.valid) {
    result.reason = ReasonMalformedRequest;
    return result;
  }
  if (builtin !== undefined && builtin.bodyModelRequired &&
      !jsonBodyModelMatches(request.model!, request.body)) {
    result.reason = ReasonProfileMismatch;
    return result;
  }
  if (inspected.found) {
    result.reason = ReasonCallerManaged;
    return result;
  }
  // Go resolves the profile through the builtin table here; an unknown
  // provider resolves nothing and passes through as unsupported.
  if (builtin === undefined) return result;
  const resolved = builtin.resolveProfile(request);
  if (resolved === undefined) return result;
  const profile = normalizedProfile(resolved);
  if ((profile.provider ?? "").trim() === "" ||
      (profile.provider ?? "").trim().toLowerCase() !== providerName ||
      !profileCompatible(profile, builtin.contracts)) {
    result.profile = profile;
    result.reason = ReasonProfileMismatch;
    return result;
  }
  result.profile = profile;
  const prefix = nativeStablePrefix(builtin, request);
  if (prefix === undefined) {
    result.reason = ReasonNoStablePrefix;
    return result;
  }
  const plan = engine.plan({
    scope: request.scope,
    epoch: request.epoch,
    partitionKey: request.partitionKey ?? "",
    expectedRequestsPerMinute: request.expectedRequestsPerMinute ?? 0,
    expectedCalls: request.expectedCalls ?? 0,
    profile,
    segments: [{
      name: "native-prefix",
      content: prefix,
      tokens: request.prefixTokens ?? 0,
      stable: true,
      cacheable: true,
      expectedCalls: request.expectedCalls ?? 0,
    }],
  });
  result.plan = plan;
  result.decision = plan.decision;
  result.reason = plan.reason;
  if (plan.decision !== "apply") return result;

  const compiled = builtin.compile(request, plan, profile);
  if (compiled.body.length === 0 ||
      Buffer.byteLength(compiled.body, "utf8") > engine.maxRequestBytes ||
      !validOptimizerIds(compiled.optimizerIds) || compiled.body === request.body) {
    result.decision = "pass_through";
    result.reason = ReasonTransformUnavailable;
    return result;
  }
  result.body = compiled.body;
  result.optimizerIds = [...compiled.optimizerIds];
  result.applied = true;
  result.decision = "apply";
  result.reason = ReasonApplied;
  result.claimBasis = "inferred";
  if (builtin.classify !== undefined) {
    const classified = builtin.classify(profile, compiled.optimizerIds);
    if (classified.attribution !== undefined && classified.attribution !== "") {
      result.profile.attribution = classified.attribution;
      result.plan.attribution = classified.attribution;
    }
    if (classified.reason !== undefined && classified.reason !== "") {
      result.reason = classified.reason;
    }
  }
  return result;
}

function validNativeIdentity(request: NativeCacheRequest): boolean {
  return validIdentity(request.scope, 4096, false) &&
    validIdentity(request.epoch, 4096, false) &&
    validIdentity(request.partitionKey ?? "", 4096, true) &&
    validIdentity(request.provider, 64, false) &&
    validIdentity(request.model ?? "", 512, true) &&
    validIdentity(request.region ?? "", 64, true) &&
    validIdentity(request.endpoint ?? "", 512, true) &&
    validIdentity(request.runtimeMode ?? "", 128, true) &&
    validIdentity(request.authMode ?? "", 128, true);
}

function validOptimizerIds(values: readonly string[]): boolean {
  if (values.length === 0 || values.length > 64) return false;
  const seen = new Set<string>();
  for (const value of values) {
    if (!validIdentity(value, 256, false) || seen.has(value)) return false;
    seen.add(value);
  }
  return true;
}

function profileCompatible(
  profile: CachePlanProfile,
  contracts: readonly ProfileContract[],
): boolean {
  return contracts.some((contract) =>
    profile.mode === contract.mode && profile.attribution === contract.attribution &&
    profile.maxBreakpoints === contract.maxBreakpoints &&
    profile.ttlSeconds === contract.ttlSeconds &&
    profile.rolling === contract.rolling && profile.routingKey === contract.routingKey &&
    profile.optimizerId === contract.optimizerId);
}

function jsonBodyModelMatches(model: string, body: string): boolean {
  const root = splice.root(body);
  if (root === undefined) return false;
  return splice.stringField(body, root, "model") === model;
}

function markerFor(rules: readonly MarkerRule[]): CallerMarker {
  return (path, key) => rules.some((rule) =>
    key === rule.key && rule.paths.some((expected) =>
      expected.length === path.length && expected.every((item, index) => item === path[index])));
}

// --- duplicate-key + caller-marker inspection (native.go inspectUniqueJSONObject) ---

function inspectUniqueJSONObject(
  body: string,
  marker: CallerMarker | undefined,
): { valid: boolean; found: boolean } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { valid: false, found: false };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { valid: false, found: false };
  }
  try {
    const { found } = scanUniqueValue(body, 0, 0, marker, []);
    return { valid: true, found };
  } catch {
    return { valid: false, found: false };
  }
}

const WS = new Set([" ", "\n", "\r", "\t"]);

function skipWs(body: string, pos: number): number {
  while (pos < body.length && WS.has(body[pos]!)) pos++;
  return pos;
}

function scanStringEnd(body: string, start: number): number {
  for (let i = start + 1; i < body.length; i++) {
    if (body[i] === "\\") i++;
    else if (body[i] === '"') return i + 1;
  }
  throw new Error("cache planner: unterminated string");
}

/** Walks well-formed JSON text, rejecting duplicate object keys (depth-capped). */
function scanUniqueValue(
  body: string,
  pos: number,
  depth: number,
  marker: CallerMarker | undefined,
  path: string[],
): { end: number; found: boolean } {
  if (depth > 512) throw new Error("cache planner: JSON nesting limit exceeded");
  pos = skipWs(body, pos);
  const char = body[pos];
  if (char === "{") {
    const seen = new Set<string>();
    let found = false;
    pos = skipWs(body, pos + 1);
    if (body[pos] === "}") return { end: pos + 1, found };
    for (;;) {
      const keyEnd = scanStringEnd(body, pos);
      const key = JSON.parse(body.slice(pos, keyEnd)) as string;
      if (seen.has(key)) throw new Error("cache planner: duplicate object key");
      seen.add(key);
      const matched = marker?.(path, key) ?? false;
      pos = skipWs(body, keyEnd) + 1; // ':'
      path.push(key);
      const child = scanUniqueValue(body, pos, depth + 1, marker, path);
      path.pop();
      found = found || matched || child.found;
      pos = skipWs(body, child.end);
      if (body[pos] === ",") {
        pos = skipWs(body, pos + 1);
        continue;
      }
      return { end: pos + 1, found }; // '}'
    }
  }
  if (char === "[") {
    let found = false;
    pos = skipWs(body, pos + 1);
    if (body[pos] === "]") return { end: pos + 1, found };
    path.push("*");
    try {
      for (;;) {
        const child = scanUniqueValue(body, pos, depth + 1, marker, path);
        found = found || child.found;
        pos = skipWs(body, child.end);
        if (body[pos] === ",") {
          pos = skipWs(body, pos + 1);
          continue;
        }
        return { end: pos + 1, found }; // ']'
      }
    } finally {
      path.pop();
    }
  }
  if (char === '"') return { end: scanStringEnd(body, pos), found: false };
  let end = pos;
  while (end < body.length && !WS.has(body[end]!) &&
      body[end] !== "," && body[end] !== "}" && body[end] !== "]") {
    end++;
  }
  return { end, found: false };
}

// --- native stable-prefix extraction (native.go nativeStablePrefixFor) ---

function nativeStablePrefix(
  builtin: BuiltinDefinition,
  request: NativeCacheRequest,
): Uint8Array | undefined {
  const body = request.body;
  const root = splice.root(body);
  if (root === undefined) return undefined;
  const sequence = builtin.stableSequences?.[request.endpoint ?? ""] ?? builtin.stableSequence;
  let prefix = appendFrame(Buffer.alloc(0), "provider", Buffer.from(request.provider.toLowerCase(), "utf8"));
  prefix = appendFrame(prefix, "model", Buffer.from(request.model ?? "", "utf8"));
  let found = false;
  for (const name of builtin.stableFields) {
    const span = splice.field(body, root, name);
    if (span !== undefined) {
      prefix = appendFrame(prefix, name, Buffer.from(body.slice(span.start, span.end), "utf8"));
      found = true;
    }
  }
  if (sequence !== "") {
    const span = splice.field(body, root, sequence);
    if (span !== undefined) {
      const items = splice.elements(body, span);
      if (items !== undefined && items.length > 0) {
        let leadingStable = false;
        for (let index = 0; index < items.length; index++) {
          const element = items[index]!;
          const role = splice.stringField(body, element, "role");
          if (role !== "system" && role !== "developer") break;
          prefix = appendFrame(
            prefix,
            `${sequence}[${index}]`,
            Buffer.from(body.slice(element.start, element.end), "utf8"),
          );
          leadingStable = true;
          found = true;
        }
        if (!found && !leadingStable) {
          prefix = appendFrame(
            prefix,
            `${sequence}[0]`,
            Buffer.from(body.slice(items[0]!.start, items[0]!.end), "utf8"),
          );
          found = true;
        }
      }
    }
  }
  return found ? prefix : undefined;
}

// --- Anthropic wire (splice) ---

function compileAnthropic(
  request: NativeCacheRequest,
  _plan: CachePlan,
  profile: CachePlanProfile,
): Compilation {
  const { body: stableBody, stable } = applyAnthropicStable(request.body);
  let body = stableBody;
  let ids: string[] = stable ? [profile.optimizerId] : [];
  const withRolling = appendTopLevelField(body, "cache_control", '{"type":"ephemeral"}');
  if (withRolling !== undefined) {
    body = withRolling;
    ids = appendUnique(ids, AnthropicRollingOptimizerID);
  }
  return { body, optimizerIds: ids };
}

function applyAnthropicStable(body: string): { body: string; stable: boolean } {
  let decoded: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { body, stable: false };
    }
    decoded = parsed as Record<string, unknown>;
  } catch {
    return { body, stable: false };
  }
  const root = splice.root(body);
  if (root === undefined) return { body, stable: false };
  const cacheControl = '{"type":"ephemeral"}';
  const tools = splice.field(body, root, "tools");
  if (tools !== undefined) {
    const items = splice.elements(body, tools);
    if (items !== undefined) {
      const decodedTools = Array.isArray(decoded.tools) ? decoded.tools : [];
      for (let index = items.length - 1; index >= 0; index--) {
        if (index < decodedTools.length && anthropicDeferredTool(decodedTools[index])) continue;
        const element = items[index]!;
        if (element.start < element.end && body[element.start] === "{") {
          const out = splice.appendObjectFields(body, element, {
            name: "cache_control",
            value: cacheControl,
          });
          return { body: out ?? body, stable: out !== undefined };
        }
      }
    }
  }
  const system = splice.field(body, root, "system");
  if (system === undefined || system.start >= system.end) return { body, stable: false };
  if (body[system.start] === '"') {
    const replacement = `[{"type":"text","text":${body.slice(system.start, system.end)},` +
      `"cache_control":{"type":"ephemeral"}}]`;
    const out = splice.replaceRaw(body, system, replacement);
    return { body: out ?? body, stable: out !== undefined };
  }
  if (body[system.start] === "[") {
    const items = splice.elements(body, system);
    if (items === undefined) return { body, stable: false };
    for (let index = items.length - 1; index >= 0; index--) {
      const element = items[index]!;
      if (element.start < element.end && body[element.start] === "{") {
        const out = splice.appendObjectFields(body, element, {
          name: "cache_control",
          value: cacheControl,
        });
        return { body: out ?? body, stable: out !== undefined };
      }
    }
  }
  return { body, stable: false };
}

function anthropicDeferredTool(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (value as { defer_loading?: unknown }).defer_loading === true;
}

function appendTopLevelField(body: string, name: string, value: string): string | undefined {
  const root = splice.root(body);
  if (root === undefined) return undefined;
  if (splice.field(body, root, name) !== undefined) return undefined;
  return splice.appendObjectFields(body, root, { name, value });
}

function appendUnique(values: string[], value: string): string[] {
  return values.includes(value) ? values : [...values, value];
}

// --- OpenAI wire (splice; string content converts to blocks only where the
// explicit breakpoint grammar requires it — wire-equivalent, per cacheengine) ---

function compileOpenAI(
  request: NativeCacheRequest,
  plan: CachePlan,
  profile: CachePlanProfile,
): Compilation {
  return applyOpenAI(
    request.body,
    request.endpoint ?? "",
    plan.routing_key ?? "",
    profile.mode === "explicit",
  );
}

function classifyOpenAICompilation(
  profile: CachePlanProfile,
  optimizerIds: readonly string[],
): { attribution?: CacheAttribution; reason?: string } {
  if (profile.mode === "explicit" && !optimizerIds.includes(OpenAIExplicitOptimizerID)) {
    return { attribution: "affinity", reason: ReasonAffinityFallback };
  }
  return {};
}

function applyOpenAI(
  body: string,
  endpoint: string,
  routingKey: string,
  explicit: boolean,
): Compilation {
  if (routingKey === "") return { body, optimizerIds: [] };
  let marked = body;
  let breakpoint = false;
  if (explicit) {
    const result = markOpenAIBreakpoints(body, endpoint);
    marked = result.body;
    breakpoint = result.marked;
  }
  const root = splice.root(marked);
  if (root === undefined) return { body, optimizerIds: [] };
  const insertions: splice.FieldInsertion[] = [
    { name: "prompt_cache_key", value: goQuote(routingKey) },
  ];
  const ids = [OpenAIKeyOptimizerID];
  if (breakpoint) {
    insertions.push({ name: "prompt_cache_options", value: '{"mode":"explicit"}' });
    ids.push(OpenAIExplicitOptimizerID);
  }
  const out = splice.appendObjectFields(marked, root, ...insertions);
  if (out === undefined) return { body, optimizerIds: [] };
  return { body: out, optimizerIds: ids };
}

/**
 * Keeps one stable anchor plus the latest three cacheable message blocks
 * marked, exactly like the Go wire: explicit mode does not fall back to
 * unmarked prefixes, so retaining prior rolling markers lets request N+1 read
 * the prefix written by request N with at most one new rolling write.
 */
function markOpenAIBreakpoints(body: string, endpoint: string): { body: string; marked: boolean } {
  const root = splice.root(body);
  if (root === undefined) return { body, marked: false };
  let sequenceName = "messages";
  let stringBlockType = "text";
  let supported = new Set(["text", "image_url", "input_audio", "file", "refusal"]);
  if (endpoint.toLowerCase().includes("responses")) {
    sequenceName = "input";
    stringBlockType = "input_text";
    supported = new Set(["input_text", "input_image", "input_file"]);
  }
  const sequence = splice.field(body, root, sequenceName);
  if (sequence === undefined) return { body, marked: false };
  const items = splice.elements(body, sequence);
  if (items === undefined || items.length === 0) return { body, marked: false };
  const markable: number[] = [];
  let stable = -1;
  let leadingStable = true;
  for (let index = 0; index < items.length; index++) {
    const item = items[index]!;
    const role = splice.stringField(body, item, "role");
    if (role !== "system" && role !== "developer") leadingStable = false;
    if (!openAICacheableRole(role, sequenceName) || !openAIItemMarkable(body, item, supported)) {
      continue;
    }
    markable.push(index);
    if (leadingStable) stable = index;
  }
  if (markable.length === 0) return { body, marked: false };
  const selected = new Set<number>();
  if (stable >= 0) selected.add(stable);
  for (let index = markable.length - 1; index >= 0 && selected.size < 4; index--) {
    selected.add(markable[index]!);
  }
  const indices = [...selected].sort((a, b) => b - a);
  let marked = body;
  let count = 0;
  for (const index of indices) {
    // Descending targets keep every earlier original span valid: each prior
    // insertion/replacement occurred strictly after the next target.
    const next = markOpenAIItem(marked, items[index]!, stringBlockType, supported);
    if (next === undefined) return { body, marked: false };
    marked = next;
    count++;
  }
  return { body: marked, marked: count > 0 };
}

function openAICacheableRole(role: string | undefined, sequenceName: string): boolean {
  if (sequenceName === "input") {
    return role === "system" || role === "developer" || role === "user" || role === "assistant";
  }
  return role === "system" || role === "developer" || role === "user" ||
    role === "assistant" || role === "tool";
}

function openAIItemMarkable(body: string, item: splice.Span, supported: ReadonlySet<string>): boolean {
  const content = splice.field(body, item, "content");
  if (content === undefined) return false;
  const text = splice.stringValue(body, content);
  if (text !== undefined || body[content.start] === '"') return text !== undefined && text !== "";
  const blocks = splice.elements(body, content);
  if (blocks === undefined) return false;
  return blocks.some((block) => {
    const blockType = splice.stringField(body, block, "type");
    return blockType !== undefined && supported.has(blockType);
  });
}

function markOpenAIItem(
  body: string,
  item: splice.Span,
  stringBlockType: string,
  supported: ReadonlySet<string>,
): string | undefined {
  const content = splice.field(body, item, "content");
  if (content === undefined) return undefined;
  if (body[content.start] === '"') {
    const text = splice.stringValue(body, content);
    if (text === undefined || text === "") return undefined;
    const replacement = `[{"type":"${stringBlockType}","text":${goQuote(text)},` +
      `"prompt_cache_breakpoint":{"mode":"explicit"}}]`;
    return splice.replaceRaw(body, content, replacement);
  }
  const blocks = splice.elements(body, content);
  if (blocks === undefined) return undefined;
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index]!;
    const blockType = splice.stringField(body, block, "type");
    if (blockType === undefined || !supported.has(blockType)) continue;
    if (splice.field(body, block, "prompt_cache_breakpoint") !== undefined) return undefined;
    return splice.appendObjectFields(body, block, {
      name: "prompt_cache_breakpoint",
      value: '{"mode":"explicit"}',
    });
  }
  return undefined;
}

// --- Bedrock wire (sorted-key reserialization, as Go json.Marshal does) ---

function compileBedrock(
  request: NativeCacheRequest,
  _plan: CachePlan,
  profile: CachePlanProfile,
): Compilation {
  const endpoint = request.endpoint ?? "";
  const { body: stableBody, stable } = applyBedrockStable(request.body, endpoint);
  let body = stableBody;
  let ids: string[] = stable ? [profile.optimizerId] : [];
  if (profile.rolling) {
    const rolling = appendBedrockRolling(body, endpoint);
    if (rolling !== undefined) {
      body = rolling;
      ids = appendUnique(ids, BedrockRollingOptimizerID);
    }
  }
  return { body, optimizerIds: ids };
}

function applyBedrockStable(body: string, endpoint: string): { body: string; stable: boolean } {
  let root: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { body, stable: false };
    }
    root = parsed as Record<string, unknown>;
  } catch {
    return { body, stable: false };
  }
  let injected: boolean;
  switch (endpoint) {
    case "converse":
    case "converse-stream":
      injected = injectBedrockConverseStable(root);
      break;
    case "invoke":
    case "invoke-with-response-stream":
      injected = injectBedrockInvokeStable(root);
      break;
    default:
      return { body, stable: false };
  }
  if (!injected) return { body, stable: false };
  return { body: goMarshal(root), stable: true };
}

function injectBedrockConverseStable(root: Record<string, unknown>): boolean {
  if ("toolConfig" in root) {
    const toolConfig = root.toolConfig;
    if (toolConfig === null || typeof toolConfig !== "object" || Array.isArray(toolConfig)) {
      return false;
    }
    const config = toolConfig as Record<string, unknown>;
    if (!("tools" in config)) return false;
    const tools = config.tools;
    if (!Array.isArray(tools) || tools.length === 0) return false;
    if (tools.some((tool) => tool === null || typeof tool !== "object" || Array.isArray(tool))) {
      return false;
    }
    config.tools = [...tools, { cachePoint: { type: "default" } }];
    return true;
  }
  if (!("system" in root)) return false;
  const system = root.system;
  if (!Array.isArray(system) || system.length === 0) return false;
  if (system.some((block) => block === null || typeof block !== "object" || Array.isArray(block))) {
    return false;
  }
  root.system = [...system, { cachePoint: { type: "default" } }];
  return true;
}

function injectBedrockInvokeStable(root: Record<string, unknown>): boolean {
  const tools = root.tools;
  if (Array.isArray(tools) && tools.length > 0) {
    for (let index = tools.length - 1; index >= 0; index--) {
      const tool: unknown = tools[index];
      if (tool !== null && typeof tool === "object" && !Array.isArray(tool)) {
        (tool as Record<string, unknown>).cache_control = { type: "ephemeral" };
        return true;
      }
    }
  }
  const system = root.system;
  if (typeof system === "string") {
    if (system === "") return false;
    root.system = [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
    return true;
  }
  if (Array.isArray(system)) {
    for (let index = system.length - 1; index >= 0; index--) {
      const block: unknown = system[index];
      if (block !== null && typeof block === "object" && !Array.isArray(block)) {
        (block as Record<string, unknown>).cache_control = { type: "ephemeral" };
        return true;
      }
    }
  }
  return false;
}

function appendBedrockRolling(body: string, endpoint: string): string | undefined {
  let root: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    root = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const messages = root.messages;
  if (!Array.isArray(messages) || messages.length === 0) return undefined;
  const latest: unknown = messages[messages.length - 1];
  if (latest === null || typeof latest !== "object" || Array.isArray(latest)) return undefined;
  const message = latest as Record<string, unknown>;
  switch (endpoint) {
    case "converse":
    case "converse-stream": {
      const content = message.content;
      if (!Array.isArray(content) || content.length === 0) return undefined;
      message.content = [...content, { cachePoint: { type: "default" } }];
      break;
    }
    case "invoke":
    case "invoke-with-response-stream": {
      const content = message.content;
      if (typeof content === "string") {
        if (content === "") return undefined;
        message.content = [{
          type: "text",
          text: content,
          cache_control: { type: "ephemeral" },
        }];
      } else if (Array.isArray(content)) {
        if (content.length === 0) return undefined;
        const block: unknown = content[content.length - 1];
        if (block === null || typeof block !== "object" || Array.isArray(block)) return undefined;
        (block as Record<string, unknown>).cache_control = { type: "ephemeral" };
      } else {
        return undefined;
      }
      break;
    }
    default:
      return undefined;
  }
  return goMarshal(root);
}

// --- Go json.Marshal reproduction (sorted keys, HTML escaping) ---

/** Encodes exactly like Go json.Marshal: sorted object keys, HTML-escaped strings. */
export function goMarshal(value: unknown): string {
  if (value === null || value === undefined) return "null";
  switch (typeof value) {
    case "string":
      return goQuote(value);
    case "number":
      return goNumber(value);
    case "boolean":
      return value ? "true" : "false";
  }
  if (Array.isArray(value)) return `[${value.map((item) => goMarshal(item)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${goQuote(key)}:${goMarshal(record[key])}`).join(",")}}`;
  }
  throw new Error("cache planner: value is not JSON-serializable");
}

/** Go json string encoding: HTML-escapes &, <, >, and U+2028/U+2029. */
export function goQuote(value: string): string {
  let out = '"';
  for (const char of value) {
    switch (char) {
      case '"': out += '\\"'; break;
      case "\\": out += "\\\\"; break;
      case "\n": out += "\\n"; break;
      case "\r": out += "\\r"; break;
      case "\t": out += "\\t"; break;
      case "<": out += "\\u003c"; break;
      case ">": out += "\\u003e"; break;
      case "&": out += "\\u0026"; break;
      case "\u2028": out += "\\u2028"; break;
      case "\u2029": out += "\\u2029"; break;
      default: {
        const code = char.codePointAt(0)!;
        if (code < 0x20) out += `\\u${code.toString(16).padStart(4, "0")}`;
        else out += char;
      }
    }
  }
  return `${out}"`;
}

function goNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error("cache planner: non-finite number");
  // Go pads single-digit exponents (1e-7 renders as 1e-07).
  return String(value).replace(/e([+-])(\d)$/, "e$10$2");
}
