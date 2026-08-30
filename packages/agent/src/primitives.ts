import { Type, type Static, type TSchema } from "@earendil-works/pi-ai";
import type { Grader } from "@caveman-ai/evals";
import type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
} from "@standard-schema/spec";
import type { ConnectToolRuntimeDefinition } from "./connect.js";
import type { MemoryAmbientOptions } from "./memory.js";
import {
  type CapturedStandardSchema,
  TOOL_RAW_EXECUTE,
  TOOL_SCHEMA_IMPLEMENTATION_SOURCE,
  TOOL_STANDARD_SCHEMA,
  TOOL_STANDARD_OUTPUT,
  executableSchemaImplementationSource,
  settleToolOutput,
  snapshotToolSchema,
  standardSchemaImplementationSource,
  standardReceiverState,
  validateCapturedStandardSchema,
} from "./tool-internal.js";

const TOOL_IMPLEMENTATION_SOURCE = Symbol.for(
  "@caveman-ai/agent:tool-implementation-source",
);
/**
 * Marks a definition whose input is a Standard Schema, so a wrapper that can
 * only re-check the converted draft-07 JSON Schema (see `routine()`) can refuse
 * rather than silently drop the vendor's refinements and transforms.
 */
export const AUTO = Symbol.for("@caveman-ai/agent:auto");
export type Auto = { readonly kind: "auto"; readonly [AUTO]: true };

export function auto(): Auto {
  return Object.freeze({ kind: "auto", [AUTO]: true as const });
}

export interface FileSource {
  readonly kind: "file";
  readonly path: string;
}

export function file(path: string): FileSource {
  if (typeof path !== "string" || path.trim() === "") {
    throw new Error("caveman agent: file path is required");
  }
  return Object.freeze({ kind: "file", path });
}

export const schema = {
  any: () => Type.Any(),
  array: <T extends TSchema>(items: T) => Type.Array(items),
  boolean: () => Type.Boolean(),
  integer: () => Type.Integer(),
  literal: <T extends string | number | boolean>(value: T) => Type.Literal(value),
  null: () => Type.Null(),
  number: () => Type.Number(),
  object: <T extends Record<string, TSchema>>(properties: T) => Type.Object(properties),
  optional: <T extends TSchema>(value: T) => Type.Optional(value),
  string: () => Type.String(),
  union: <T extends TSchema[]>(values: [...T]) => Type.Union(values),
};

export type ToolEffect = "read" | "write" | "idempotent" | "external";
export type ToolResultPolicy = "auto" | "inline" | "page" | "compress" | "exact_ccr";

export interface NestedToolDispatchOptions {
  /** Additional cancellation owned by the composite program. */
  readonly signal?: AbortSignal;
  /**
   * Claim a matching read that this run's kernel already admitted while the
   * provider streamed the composite call. Missing or ambiguous provenance
   * fails closed and executes the call normally.
   */
  readonly claimSpeculation?: boolean;
}

export interface ToolExecutionContext {
  /** Provider identity for this exact tool invocation. */
  readonly toolCallId: string;
  /** Stable, non-secret durable identity. Present only on durable runs. */
  readonly durable?: {
    readonly idempotencyKey: string;
    /** True when this invocation safely re-drives an unmatched prior intent. */
    readonly resumed: boolean;
  };
  /** Composite parent identity; equals toolCallId on a top-level invocation. */
  readonly parentToolCallId: string;
  /** Dispatch one declared nested tool through the run's canonical kernel. */
  dispatch(
    name: string,
    input: unknown,
    options?: NestedToolDispatchOptions,
  ): Promise<unknown>;
}

export interface SubagentRuntimeDefinition {
  readonly kind: "subagent";
  readonly definition: unknown;
  readonly maxInputChars: number;
  readonly maxCalls: number;
  readonly maxCostUsd: number;
  /**
   * The token-denominated sibling of `maxCostUsd`. A run metered in tokens
   * carves this child's wallet from it; without it, such a run cannot fund
   * this subagent at all.
   */
  readonly maxTokens?: number;
  readonly maxContextTokens: number;
}

export type ToolRuntimeDefinition = SubagentRuntimeDefinition | ConnectToolRuntimeDefinition;

export type StandardToolSchema<Input = unknown, Output = Input> =
  StandardSchemaV1<Input, Output> & StandardJSONSchemaV1<Input, Output>;

export interface ToolDefinition<TInput = unknown, TResult = unknown> {
  readonly kind: "tool";
  readonly name: string;
  readonly description: string;
  readonly input: TSchema;
  /** Declared result contract. Validated before any result reaches model context. */
  readonly output?: TSchema;
  /** Stable digest required to lock/durably replay mutable custom schema semantics. */
  readonly schemaSemanticsSHA256?: string;
  readonly effect: ToolEffect;
  readonly result: ToolResultPolicy;
  readonly artifact?: ArtifactDefinition;
  /**
   * Opt this tool out of the repeated-call loop breaker. Set it on tools whose
   * job is to be called again with the same arguments — polling a queue,
   * waiting on a build, re-reading a file that changes underneath.
   */
  readonly allowRepeat?: boolean;
  /** Explicit opt-in for kernel-owned streaming speculation. Read tools only. */
  readonly speculative?: boolean;
  readonly timeoutMs: number;
  readonly runtime?: ToolRuntimeDefinition;
  /** Flat, kernel-dispatched tools available only inside this composite tool. */
  readonly nestedTools?: readonly ToolDefinition[];
  /** Nested read tools whose already-started result may be consumed safely. */
  readonly speculativeTools?: readonly string[];
  readonly execute: {
    bivarianceHack(
      input: TInput,
      signal?: AbortSignal,
      context?: ToolExecutionContext,
    ): TResult | Promise<TResult>;
  }["bivarianceHack"];
}

export interface ToolOptions<TInput extends TSchema, TExecuteResult, TResult = TExecuteResult> {
  name: string;
  description: string;
  input: TInput & { readonly "~standard"?: never };
  /** TypeBox/JSON Schema or Standard Schema result contract. */
  output?: StandardSchemaV1<TExecuteResult, TResult>;
  /** Required only when a Standard output schema cannot emit draft-07. */
  outputJSONSchema?: TSchema;
  /** SHA-256 of Standard/custom-format validator semantics and captured state. */
  schemaSemanticsSHA256?: string;
  effect: ToolEffect;
  result?: ToolResultPolicy | ArtifactDefinition;
  /** See {@link ToolDefinition.allowRepeat}. */
  allowRepeat?: boolean;
  /** See {@link ToolDefinition.speculative}. */
  speculative?: boolean;
  timeoutMs?: number;
  runtime?: ToolRuntimeDefinition;
  nestedTools?: readonly ToolDefinition[];
  speculativeTools?: readonly string[];
  execute: (
    input: Static<TInput>,
    signal?: AbortSignal,
    context?: ToolExecutionContext,
  ) => TExecuteResult | Promise<TExecuteResult>;
}

export interface TypeBoxOutputToolOptions<
  TInput extends TSchema,
  TOutput extends TSchema,
> extends Omit<
    ToolOptions<TInput, Static<TOutput>, Static<TOutput>>,
    "output" | "outputJSONSchema"
  > {
  output: TOutput & { readonly "~standard"?: never };
  outputJSONSchema?: never;
}

export interface StandardOutputToolOptions<
  TInput extends TSchema,
  TOutput extends StandardSchemaV1,
> extends Omit<
    ToolOptions<
      TInput,
      StandardSchemaV1.InferInput<TOutput>,
      StandardSchemaV1.InferOutput<TOutput>
  >,
    "output"
  > {
  output: TOutput;
}

export interface StandardToolOptions<
  Input,
  Output,
  TExecuteResult,
  TResult = TExecuteResult,
> {
  name: string;
  description: string;
  input: StandardSchemaV1<Input, Output>;
  inputJSONSchema: TSchema;
  /** TypeBox/JSON Schema or Standard Schema result contract. */
  output?: StandardSchemaV1<TExecuteResult, TResult>;
  /** Required only when a Standard output schema cannot emit draft-07. */
  outputJSONSchema?: TSchema;
  /** SHA-256 of Standard/custom-format validator semantics and captured state. */
  schemaSemanticsSHA256?: string;
  effect: ToolEffect;
  result?: ToolResultPolicy | ArtifactDefinition;
  /** See {@link ToolDefinition.allowRepeat}. */
  allowRepeat?: boolean;
  /** See {@link ToolDefinition.speculative}. */
  speculative?: boolean;
  timeoutMs?: number;
  runtime?: ToolRuntimeDefinition;
  nestedTools?: readonly ToolDefinition[];
  speculativeTools?: readonly string[];
  execute: (
    input: Output,
    signal?: AbortSignal,
    context?: ToolExecutionContext,
  ) => TExecuteResult | Promise<TExecuteResult>;
}

export interface StandardTypeBoxOutputToolOptions<
  Input,
  Output,
  TOutput extends TSchema,
> extends Omit<
    StandardToolOptions<Input, Output, Static<TOutput>, Static<TOutput>>,
    "output" | "outputJSONSchema"
  > {
  output: TOutput & { readonly "~standard"?: never };
  outputJSONSchema?: never;
}

export interface StandardInputOutputToolOptions<
  Input,
  Output,
  TOutput extends StandardSchemaV1,
> extends Omit<
    StandardToolOptions<
      Input,
      Output,
      StandardSchemaV1.InferInput<TOutput>,
      StandardSchemaV1.InferOutput<TOutput>
    >,
    "output"
  > {
  output: TOutput;
}

export interface StandardJSONToolOptions<
  Input,
  Output,
  TExecuteResult,
  TResult = TExecuteResult,
> extends Omit<
    StandardToolOptions<Input, Output, TExecuteResult, TResult>,
    "input" | "inputJSONSchema"
  > {
  input: StandardToolSchema<Input, Output>;
  inputJSONSchema?: never;
}

export interface StandardJSONTypeBoxOutputToolOptions<
  Input,
  Output,
  TOutput extends TSchema,
> extends Omit<
    StandardJSONToolOptions<Input, Output, Static<TOutput>, Static<TOutput>>,
    "output" | "outputJSONSchema"
  > {
  output: TOutput & { readonly "~standard"?: never };
  outputJSONSchema?: never;
}

export interface StandardJSONOutputToolOptions<
  Input,
  Output,
  TOutput extends StandardSchemaV1,
> extends Omit<
    StandardJSONToolOptions<
      Input,
      Output,
      StandardSchemaV1.InferInput<TOutput>,
      StandardSchemaV1.InferOutput<TOutput>
    >,
    "output"
  > {
  output: TOutput;
}

export function tool<TInput extends TSchema, TOutput extends TSchema>(
  options: TypeBoxOutputToolOptions<TInput, TOutput>,
): ToolDefinition<Static<TInput>, Static<TOutput>>;
export function tool<TInput extends TSchema, TOutput extends StandardSchemaV1>(
  options: StandardOutputToolOptions<TInput, TOutput>,
): ToolDefinition<Static<TInput>, StandardSchemaV1.InferOutput<TOutput>>;
export function tool<TInput extends TSchema, TExecuteResult, TResult = TExecuteResult>(
  options: ToolOptions<TInput, TExecuteResult, TResult>,
): ToolDefinition<Static<TInput>, TResult>;
export function tool<Input, Output, TOutput extends TSchema>(
  options: StandardTypeBoxOutputToolOptions<Input, Output, TOutput>,
): ToolDefinition<Output, Static<TOutput>>;
export function tool<Input, Output, TOutput extends StandardSchemaV1>(
  options: StandardInputOutputToolOptions<Input, Output, TOutput>,
): ToolDefinition<Output, StandardSchemaV1.InferOutput<TOutput>>;
export function tool<Input, Output, TExecuteResult, TResult = TExecuteResult>(
  options: StandardToolOptions<Input, Output, TExecuteResult, TResult>,
): ToolDefinition<Output, TResult>;
export function tool<Input, Output, TOutput extends TSchema>(
  options: StandardJSONTypeBoxOutputToolOptions<Input, Output, TOutput>,
): ToolDefinition<Output, Static<TOutput>>;
export function tool<Input, Output, TOutput extends StandardSchemaV1>(
  options: StandardJSONOutputToolOptions<Input, Output, TOutput>,
): ToolDefinition<Output, StandardSchemaV1.InferOutput<TOutput>>;
export function tool<Input, Output, TExecuteResult, TResult = TExecuteResult>(
  options: StandardJSONToolOptions<Input, Output, TExecuteResult, TResult>,
): ToolDefinition<Output, TResult>;
export function tool(
  options: ToolOptions<TSchema, unknown, unknown> |
    TypeBoxOutputToolOptions<TSchema, TSchema> |
    StandardOutputToolOptions<TSchema, StandardSchemaV1> |
    StandardToolOptions<unknown, unknown, unknown, unknown> |
    StandardTypeBoxOutputToolOptions<unknown, unknown, TSchema> |
    StandardInputOutputToolOptions<unknown, unknown, StandardSchemaV1> |
    StandardJSONToolOptions<unknown, unknown, unknown, unknown> |
    StandardJSONTypeBoxOutputToolOptions<unknown, unknown, TSchema> |
    StandardJSONOutputToolOptions<unknown, unknown, StandardSchemaV1>,
): ToolDefinition<unknown, unknown> {
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/.test(options.name)) {
    throw new Error(`caveman agent: invalid tool name ${JSON.stringify(options.name)}`);
  }
  if (options.schemaSemanticsSHA256 !== undefined &&
      !/^[0-9a-f]{64}$/.test(options.schemaSemanticsSHA256)) {
    throw new Error("caveman agent: schemaSemanticsSHA256 must be lowercase SHA-256");
  }
  if (!["read", "write", "idempotent", "external"].includes(options.effect)) {
    throw new Error(`caveman agent: unknown tool effect ${JSON.stringify(options.effect)}`);
  }
  if (options.speculative === true && options.effect !== "read") {
    throw new Error("caveman agent: speculative tool must be read-only");
  }
  const result = typeof options.result === "object"
    ? artifactResultPolicy(options.result)
    : options.result ?? "auto";
  if (!["auto", "inline", "page", "compress", "exact_ccr"].includes(result)) {
    throw new Error(`caveman agent: unknown tool result policy ${JSON.stringify(result)}`);
  }
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("caveman agent: tool timeoutMs must be a positive integer");
  }
  const nestedTools = options.nestedTools === undefined
    ? undefined
    : Object.freeze([...options.nestedTools]);
  if (nestedTools !== undefined) {
    if (options.runtime !== undefined) {
      throw new Error("caveman agent: composite tool runtime unsupported");
    }
    if (options.effect === "read" && nestedTools.some((nested) => nested.effect !== "read")) {
      throw new Error("caveman agent: read composite cannot contain effectful nested tools");
    }
    const names = new Set<string>();
    for (const nested of nestedTools) {
      if (nested.runtime !== undefined && nested.runtime.kind !== "subagent") {
        throw new Error(`caveman agent: nested tool runtime unsupported ${JSON.stringify(nested.name)}`);
      }
      if (nested.nestedTools !== undefined) {
        throw new Error(`caveman agent: nested tools must be flat ${JSON.stringify(nested.name)}`);
      }
      if (nested.name === options.name || names.has(nested.name)) {
        throw new Error(`caveman agent: duplicate nested tool ${JSON.stringify(nested.name)}`);
      }
      names.add(nested.name);
    }
  }
  const speculativeTools = options.speculativeTools === undefined
    ? undefined
    : Object.freeze([...options.speculativeTools]);
  if (speculativeTools !== undefined) {
    if (nestedTools === undefined) {
      throw new Error("caveman agent: speculativeTools requires nestedTools");
    }
    const nestedByName = new Map(nestedTools.map((nested) => [nested.name, nested]));
    const seen = new Set<string>();
    for (const name of speculativeTools) {
      const nested = nestedByName.get(name);
      if (nested === undefined || nested.effect !== "read" || nested.speculative !== true ||
          seen.has(name)) {
        throw new Error(`caveman agent: invalid speculative nested tool ${JSON.stringify(name)}`);
      }
      seen.add(name);
    }
  }
  const standard = standardToolSchema(options.input, "input");
  let input: TSchema;
  if (standard === undefined) {
    input = snapshotToolSchema(options.input, "input");
  } else {
    let converted = "inputJSONSchema" in options
      ? options.inputJSONSchema
      : undefined;
    if (converted === undefined && standard.converter !== undefined) {
      try {
        converted = Reflect.apply(
          standard.converter,
          standard.converterReceiver,
          [{ target: "draft-07" }],
        ) as TSchema;
      } catch (error) {
        throw new Error("caveman agent: Standard Schema cannot emit draft-07 input JSON Schema", {
          cause: error,
        });
      }
    }
    if (converted === undefined) {
      throw new Error(
        "caveman agent: Standard Schema needs inputJSONSchema or Standard JSON Schema conversion",
      );
    }
    if (!isRecord(converted)) {
      throw new Error("caveman agent: Standard Schema emitted invalid input JSON Schema");
    }
    input = snapshotToolSchema(converted, "input");
  }
  const declaredOutput = options.output;
  const outputStandard = declaredOutput === undefined
    ? undefined
    : standardToolSchema(declaredOutput, "output");
  let outputSchema: TSchema | undefined;
  if (declaredOutput === undefined) {
    if (options.outputJSONSchema !== undefined) {
      throw new Error("caveman agent: outputJSONSchema requires a Standard output schema");
    }
  } else if (outputStandard === undefined) {
    if (options.outputJSONSchema !== undefined) {
      throw new Error("caveman agent: outputJSONSchema is only valid with Standard Schema");
    }
    outputSchema = snapshotToolSchema(declaredOutput, "output");
  } else {
    let converted = options.outputJSONSchema;
    if (converted === undefined && outputStandard.converter !== undefined) {
      try {
        converted = Reflect.apply(
          outputStandard.converter,
          outputStandard.converterReceiver,
          [{ target: "draft-07" }],
        ) as TSchema;
      } catch (error) {
        throw new Error("caveman agent: Standard Schema cannot emit draft-07 output JSON Schema", {
          cause: error,
        });
      }
    }
    if (converted === undefined) {
      throw new Error(
        "caveman agent: Standard output Schema needs outputJSONSchema or Standard JSON Schema conversion",
      );
    }
    if (!isRecord(converted)) {
      throw new Error("caveman agent: Standard Schema emitted invalid output JSON Schema");
    }
    outputSchema = snapshotToolSchema(converted, "output");
  }
  const executeRaw = async (
    value: unknown,
    signal?: AbortSignal,
    context?: ToolExecutionContext,
  ): Promise<unknown> => {
    if (standard === undefined) {
      return options.execute(value as never, signal, context);
    }
    const validated = await validateCapturedStandardSchema(
      standard,
      value,
      `cave_tool_input_schema_mismatch:${options.name}`,
    );
    return options.execute(validated, signal, context);
  };
  const definition = {
    kind: "tool",
    name: options.name,
    description: options.description,
    input,
    ...(outputSchema === undefined ? {} : { output: outputSchema }),
    ...(options.schemaSemanticsSHA256 === undefined
      ? {}
      : { schemaSemanticsSHA256: options.schemaSemanticsSHA256 }),
    effect: options.effect,
    result,
    ...(typeof options.result === "object" ? { artifact: options.result } : {}),
    ...(options.allowRepeat === undefined ? {} : { allowRepeat: options.allowRepeat }),
    ...(options.speculative === undefined ? {} : { speculative: options.speculative }),
    timeoutMs,
    ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
    ...(nestedTools === undefined ? {} : { nestedTools }),
    ...(speculativeTools === undefined ? {} : { speculativeTools }),
    async execute(value: unknown, signal?: AbortSignal, context?: ToolExecutionContext) {
      const result = await executeRaw(value, signal, context);
      if (outputSchema === undefined) return result;
      return (await settleToolOutput(definition, result)).value;
    },
  } as const;
  // A wrapper (`routine()`) whose own `execute` source is identical for every
  // instance may declare the source that actually identifies it; otherwise the
  // closure's own text is the identity that lock/drift/durable checks fold in.
  const declaredSource = Reflect.get(options, TOOL_IMPLEMENTATION_SOURCE);
  Object.defineProperty(definition, TOOL_IMPLEMENTATION_SOURCE, {
    value: typeof declaredSource === "string"
      ? declaredSource
      : Function.prototype.toString.call(options.execute),
    enumerable: false,
    configurable: false,
    writable: false,
  });
  Object.defineProperty(definition, TOOL_RAW_EXECUTE, {
    value: executeRaw,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  if (outputStandard !== undefined) {
    Object.defineProperty(definition, TOOL_STANDARD_OUTPUT, {
      value: outputStandard,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  const schemaImplementationSource = [
    standard === undefined ? "" : standardSchemaImplementationSource(standard),
    executableSchemaImplementationSource(input),
    outputStandard === undefined ? "" : standardSchemaImplementationSource(outputStandard),
    outputSchema === undefined ? "" : executableSchemaImplementationSource(outputSchema),
  ].filter((source) => source !== "").join("\n---\n");
  if (schemaImplementationSource !== "") {
    Object.defineProperty(definition, TOOL_SCHEMA_IMPLEMENTATION_SOURCE, {
      value: schemaImplementationSource,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  if (standard !== undefined || outputStandard !== undefined) {
    Object.defineProperty(definition, TOOL_STANDARD_SCHEMA, {
      value: true,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  return Object.freeze(definition);
}

function standardToolSchema(
  value: unknown,
  direction: "input" | "output",
): CapturedStandardSchema | undefined {
  if (!isRecord(value)) return undefined;
  const standard = Reflect.get(value, "~standard") as unknown;
  if (!isRecord(standard)) return undefined;
  const version = Reflect.get(standard, "version") as unknown;
  const vendor = Reflect.get(standard, "vendor") as unknown;
  const validate = Reflect.get(standard, "validate") as unknown;
  if (version !== 1 || typeof vendor !== "string" || typeof validate !== "function") {
    throw new Error(
      "caveman agent: tool Standard Schema must implement version 1 validation",
    );
  }
  const converterReceiver = Reflect.get(standard, "jsonSchema") as unknown;
  let converter: unknown;
  if (converterReceiver !== undefined) {
    if (!isRecord(converterReceiver)) {
      throw new Error("caveman agent: tool Standard JSON Schema converter is invalid");
    }
    converter = Reflect.get(converterReceiver, direction);
    if (typeof converter !== "function") {
      throw new Error("caveman agent: tool Standard JSON Schema converter is invalid");
    }
  }
  const capturedConverterReceiver = converter === undefined
    ? undefined
    : converterReceiver;
  if (converter !== undefined &&
      (capturedConverterReceiver === null || typeof capturedConverterReceiver !== "object")) {
    throw new Error("caveman agent: tool Standard JSON Schema converter is invalid");
  }
  return Object.freeze({
    version,
    vendor,
    receiver: standard,
    receiverState: standardReceiverState(standard),
    validate: validate as CapturedStandardSchema["validate"],
    ...(converter === undefined
      ? {}
      : {
          converterReceiver: capturedConverterReceiver as object,
          converter: converter as NonNullable<CapturedStandardSchema["converter"]>,
        }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function artifactResultPolicy(definition: ArtifactDefinition): ToolResultPolicy {
  if (definition.strategy === "verbatim") {
    return definition.recovery === "exact_ccr" ? "exact_ccr" : "inline";
  }
  if (definition.strategy === "json-index") return "compress";
  return "page";
}

export interface MemoryDefinition {
  readonly kind: "memory";
  readonly namespace: string;
  readonly provenance: "local" | "project" | "external";
  readonly ttl: string;
  readonly recallBudget: number;
  readonly consent: "local_only" | "project_shared";
  /** Async passive recall/extraction policy. False keeps explicit tools only. */
  readonly ambient: false | MemoryAmbientOptions;
}

export function memoryTTLMilliseconds(value: string): number {
  const match = /^([1-9][0-9]*)(m|h|d)$/.exec(value);
  if (!match) throw new Error("cave_memory_ttl_invalid");
  const amount = Number(match[1]);
  const scale = match[2] === "m" ? 60_000 : match[2] === "h" ? 3_600_000 : 86_400_000;
  const milliseconds = amount * scale;
  if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    throw new Error("cave_memory_ttl_invalid");
  }
  return milliseconds;
}

export function memory(options: {
  namespace: string;
  provenance?: MemoryDefinition["provenance"];
  ttl?: string;
  recallBudget?: number;
  consent?: MemoryDefinition["consent"];
  ambient?: false | MemoryAmbientOptions;
}): MemoryDefinition {
  if (!/^[a-z0-9][a-z0-9_-]{0,95}$/.test(options.namespace)) {
    throw new Error(`caveman agent: invalid memory namespace ${JSON.stringify(options.namespace)}`);
  }
  const recallBudget = options.recallBudget ?? 800;
  if (!Number.isSafeInteger(recallBudget) || recallBudget < 0) {
    throw new Error("caveman agent: memory recallBudget must be a non-negative integer");
  }
  const ttl = options.ttl ?? "30d";
  try {
    memoryTTLMilliseconds(ttl);
  } catch {
    throw new Error("caveman agent: memory ttl must use positive m, h, or d duration");
  }
  // Fail closed at CONSTRUCTION, not at tool-call time: the durable
  // store implements only local, single-tenant memory. A `project`/`external`
  // provenance or a `project_shared` consent is a shared-backend contract this
  // package does not provide, so it is refused here rather than burning a model
  // turn to discover a config the framework already knew was unsupported.
  const provenance = options.provenance ?? "local";
  if (provenance !== "local") {
    throw new Error("cave_memory_provenance_unsupported: only \"local\" memory is supported");
  }
  const consent = options.consent ?? "local_only";
  if (consent !== "local_only") {
    throw new Error("cave_memory_consent_unsupported: only \"local_only\" consent is supported");
  }
  return Object.freeze({
    kind: "memory",
    namespace: options.namespace,
    provenance,
    ttl,
    recallBudget,
    consent,
    ambient: options.ambient ?? {},
  });
}

export type ContextKind =
  | "instruction"
  | "user_intent"
  | "tool_schema"
  | "skill"
  | "memory"
  | "history"
  | "tool_result"
  | "artifact"
  | "error"
  | "output_contract";
export type ContextStability = "build" | "session" | "turn";
export type SafetyClass = "S0" | "S1" | "S2" | "S3" | "S4";
export type ContextPriority = "required" | "high" | "normal" | "low";
export type RecoveryKind = "none" | "exact_ccr" | "source_ref" | "recompute";
export type CacheRegion = "frozen_prefix" | "live_zone" | "uncached";
export type PrivacyClass = "content_blind" | "local_sensitive" | "connected_allowed";

export interface ContextDefinition {
  readonly kind: "context";
  readonly id: string;
  readonly segmentKind: ContextKind;
  readonly source: string | FileSource;
  readonly stability: ContextStability;
  readonly safety: SafetyClass;
  readonly priority: ContextPriority;
  readonly recovery: RecoveryKind;
  readonly cacheRegion: CacheRegion;
  readonly privacy: PrivacyClass;
  readonly opaque: boolean;
  readonly ttlTurns?: number;
}

export function context(options: {
  id: string;
  kind: ContextKind;
  source: string | FileSource;
  stability: ContextStability;
  safety?: SafetyClass;
  priority?: ContextPriority;
  recovery?: RecoveryKind;
  cacheRegion?: CacheRegion;
  privacy?: PrivacyClass;
  opaque?: boolean;
  ttlTurns?: number;
}): ContextDefinition {
  if (options.id.trim() === "") throw new Error("caveman agent: context id is required");
  if (options.ttlTurns !== undefined && (!Number.isSafeInteger(options.ttlTurns) || options.ttlTurns <= 0)) {
    throw new Error("caveman agent: context ttlTurns must be a positive integer");
  }
  const definition: ContextDefinition = {
    kind: "context",
    id: options.id,
    segmentKind: options.kind,
    source: options.source,
    stability: options.stability,
    safety: options.safety ?? "S0",
    priority: options.priority ?? "required",
    recovery: options.recovery ?? "none",
    cacheRegion: options.cacheRegion ?? (options.stability === "build" ? "frozen_prefix" : "live_zone"),
    privacy: options.privacy ?? "local_sensitive",
    opaque: options.opaque ?? false,
    ...(options.ttlTurns === undefined ? {} : { ttlTurns: options.ttlTurns }),
  };
  return Object.freeze(definition);
}

export interface ArtifactDefinition {
  readonly kind: "artifact";
  readonly strategy: "verbatim" | "json-index" | "page";
  readonly maxInlineTokens: number;
  readonly recovery: "exact_ccr" | "source_ref";
}

export function artifact(options: {
  strategy?: ArtifactDefinition["strategy"];
  maxInlineTokens?: number;
  recovery?: ArtifactDefinition["recovery"];
} = {}): ArtifactDefinition {
  const maxInlineTokens = options.maxInlineTokens ?? 1_200;
  if (!Number.isSafeInteger(maxInlineTokens) || maxInlineTokens < 0) {
    throw new Error("caveman agent: artifact maxInlineTokens must be a non-negative integer");
  }
  return Object.freeze({
    kind: "artifact",
    strategy: options.strategy ?? "page",
    maxInlineTokens,
    recovery: options.recovery ?? "exact_ccr",
  });
}

export interface OutputDefinition<TSchemaValue extends TSchema | undefined = TSchema | undefined> {
  readonly kind: "output";
  readonly maxTokens: number;
  readonly schema?: TSchemaValue;
}

export function output<T extends TSchema | undefined = undefined>(options: {
  maxTokens: number;
  schema?: T;
}): OutputDefinition<T> {
  if (!Number.isSafeInteger(options.maxTokens) || options.maxTokens <= 0) {
    throw new Error("caveman agent: output maxTokens must be a positive integer");
  }
  return Object.freeze({
    kind: "output",
    maxTokens: options.maxTokens,
    ...(options.schema === undefined ? {} : { schema: options.schema }),
  }) as OutputDefinition<T>;
}

type LowerableQualityGraderType =
  | "contains"
  | "not_contains"
  | "tool_called"
  | "exact_match"
  | "json_schema";

const LOWERABLE_QUALITY_GRADER_TYPES: ReadonlySet<Grader["type"]> = new Set([
  "contains",
  "not_contains",
  "tool_called",
  "exact_match",
  "json_schema",
]);

/**
 * Graders the native compiler can lower without model or network dependencies.
 * `exact_match` uses canonical eval semantics: trimmed, case-insensitive text by
 * default; `case_sensitive` and `remove_punctuation` opt into stricter variants.
 */
export type QualityGrader = Extract<Grader, { type: LowerableQualityGraderType }>;

/** Runtime gate shared by fixture construction and compiler admission. */
export function assertQualityGrader(grader: unknown): asserts grader is QualityGrader {
  if (!isRecord(grader) || typeof grader.type !== "string") {
    throw new Error("caveman agent: unknown grader <missing>");
  }
  const type = grader.type;
  if (!LOWERABLE_QUALITY_GRADER_TYPES.has(type as Grader["type"])) {
    throw new Error(`caveman agent: unknown grader ${type}`);
  }
  if ((type === "contains" || type === "not_contains") &&
      (!Array.isArray(grader.fragments) || grader.fragments.length === 0 ||
        grader.fragments.some((fragment: unknown) =>
          typeof fragment !== "string" || fragment.trim() === ""))) {
    throw new Error(`caveman agent: ${type} grader needs non-empty fragments`);
  }
  if (type === "tool_called" &&
      (!Array.isArray(grader.tools) || grader.tools.length === 0 ||
        grader.tools.some((name: unknown) => typeof name !== "string" || name.trim() === ""))) {
    throw new Error("caveman agent: tool_called grader needs non-empty tool names");
  }
  if (type === "exact_match") {
    if (!Object.hasOwn(grader, "expected")) {
      throw new Error("caveman agent: exact_match grader needs expected");
    }
    if (grader.case_sensitive !== undefined && typeof grader.case_sensitive !== "boolean") {
      throw new Error("caveman agent: exact_match case_sensitive must be boolean");
    }
    if (grader.remove_punctuation !== undefined &&
        typeof grader.remove_punctuation !== "boolean") {
      throw new Error("caveman agent: exact_match remove_punctuation must be boolean");
    }
  }
  if (type === "json_schema" && !isRecord(grader.schema)) {
    throw new Error("caveman agent: json_schema grader needs object schema");
  }
}

export type EvalGuardrail =
  | { type: "latency_threshold"; p95_ms: number }
  | { type: "error_rate"; max: number };

export type EvalSplit = "profile" | "development" | "holdout";

export interface EvalDefinition {
  readonly kind: "eval";
  readonly id: string;
  /** Stable task-family identifier; required by profile-guided split isolation. */
  readonly lineageId?: string;
  /**
   * Explicit compiler role. Omit for legacy v2 builds. A v3 build requires
   * every fixture to declare one role and a lineageId; it never
   * invents or randomly splits holdout evidence.
   */
  readonly split?: EvalSplit;
  readonly input: unknown;
  readonly tools: { mode: "fixture" | "live"; sandbox?: string };
  readonly quality: readonly QualityGrader[];
  readonly guardrails: readonly EvalGuardrail[];
}

export function evalFixture(options: {
  id: string;
  lineageId?: string;
  split?: EvalSplit;
  input: unknown;
  tools?: { mode: "fixture" | "live"; sandbox?: string };
  quality: QualityGrader[];
  guardrails?: EvalGuardrail[];
}): EvalDefinition {
  if (options.id.trim() === "") throw new Error("caveman agent: eval id is required");
  if (options.lineageId !== undefined && options.lineageId.trim() === "") {
    throw new Error("caveman agent: eval lineageId must be non-empty when provided");
  }
  if (options.split !== undefined &&
      !(["profile", "development", "holdout"] as const).includes(options.split)) {
    throw new Error("caveman agent: eval split must be profile, development, or holdout");
  }
  if (options.quality.length === 0) throw new Error("caveman agent: eval needs at least one quality grader");
  for (const grader of options.quality) {
    assertQualityGrader(grader);
  }
  for (const guardrail of options.guardrails ?? []) {
    if (guardrail.type === "latency_threshold" &&
        (!Number.isSafeInteger(guardrail.p95_ms) || guardrail.p95_ms <= 0)) {
      throw new Error("caveman agent: latency guardrail requires positive integer p95_ms");
    }
    if (guardrail.type === "error_rate" &&
        (!Number.isFinite(guardrail.max) || guardrail.max < 0 || guardrail.max > 1)) {
      throw new Error("caveman agent: error-rate guardrail max must be in [0,1]");
    }
  }
  const tools = options.tools ?? { mode: "fixture" as const };
  if (tools.mode === "live" && !tools.sandbox) {
    throw new Error("caveman agent: live eval tools require an explicit sandbox");
  }
  return Object.freeze({
    kind: "eval",
    id: options.id,
    ...(options.lineageId === undefined ? {} : { lineageId: options.lineageId }),
    ...(options.split === undefined ? {} : { split: options.split }),
    input: options.input,
    tools,
    quality: Object.freeze([...options.quality]),
    guardrails: Object.freeze([...(options.guardrails ?? [])]),
  });
}

export { evalFixture as eval };

// The real `subagent` builder + its SubagentDefinition live in index.ts and
// shadow this module's `export *`. A stale duplicate here (different shape:
// contextBudget/modelCallBudget) was dead and, worse, still re-exported a
// misleading type — deleted.
