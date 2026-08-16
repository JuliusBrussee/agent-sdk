import { Value } from "typebox/value";
import { tool, type ToolDefinition } from "./primitives.js";

/**
 * Closed, runtime-declared outcome vocabulary for a routine call. Unknown
 * states do not exist: every invocation lands on exactly one of these three.
 *
 * Observability only. These counts feed `observed` before/after measurement of
 * a step's spend; they are never a savings claim, never a receipt line, and
 * never touch cost math.
 */
export type RoutineOutcome =
  | "routine_hit"
  | "routine_deopt_guard"
  | "routine_deopt_error";

export interface RoutineOutcomeCount {
  readonly tool: string;
  readonly outcome: RoutineOutcome;
  readonly count: number;
}

const TOOL_IMPLEMENTATION_SOURCE = Symbol.for(
  "@caveman-ai/agent:tool-implementation-source",
);
const TOOL_STANDARD_SCHEMA = Symbol.for("@caveman-ai/agent:tool-standard-schema");
/**
 * Prefix of the implementation source a routine declares for itself. It does
 * two jobs: it folds the real `impl`/`guard` text into every digest that hashes
 * a tool definition (the wrapper's own `execute` source is identical for every
 * routine, so without it every routine hashed the same), and it is how a
 * routine recognizes another routine and refuses to wrap it.
 */
const ROUTINE_SOURCE_MARKER = "cave_routine_v1:";

const OUTCOMES = new Map<string, Map<RoutineOutcome, number>>();

function record(name: string, outcome: RoutineOutcome): void {
  const byOutcome = OUTCOMES.get(name) ?? new Map<RoutineOutcome, number>();
  byOutcome.set(outcome, (byOutcome.get(outcome) ?? 0) + 1);
  OUTCOMES.set(name, byOutcome);
}

/**
 * Routine hit/deopt counts observed **in this process**, in first-seen order.
 *
 * Scope is deliberate and honest: under the default `sandbox: "required"` a
 * tool closure runs in its own short-lived worker process, so the counts a
 * routine records there are not visible to the host and this list stays empty
 * for those runs. Empty means "not observed here", never "no deopts happened".
 * Carrying them across the worker boundary needs a tool-result protocol change
 * plus a closed-vocabulary extension on the Cloud side (`caveman.tool_events`
 * `outcome` is pinned to `ok`/`error`/`unknown` and is assigned by the gateway,
 * not accepted from a client), so it is a tracked follow-up rather than a
 * marker smuggled through a free-form field.
 */
export function routineOutcomes(): readonly RoutineOutcomeCount[] {
  const counts: RoutineOutcomeCount[] = [];
  for (const [name, byOutcome] of OUTCOMES) {
    for (const [outcome, count] of byOutcome) {
      counts.push(Object.freeze({ tool: name, outcome, count }));
    }
  }
  return Object.freeze(counts);
}

/**
 * Wrap a witnessed-deterministic tool in generated code, with the guard and
 * deopt that make the substitution safe.
 *
 * The returned tool keeps `original`'s name, description, and input schema, so
 * the model sees no change and the framework treats it as an ordinary tool —
 * the same sandbox, breaker, budget, and receipt rules apply unchanged.
 *
 * On each call: the input is checked against the original tool's schema, then
 * the optional `guard` runs. Only when both admit does `impl` run. A schema
 * failure, a guard rejection, a throwing guard, or a throwing `impl` **deopts**:
 * the original tool runs unchanged and its result is returned. No error from
 * `impl` escapes the fallback. The guard is load-bearing, not decoration —
 * loosening it is how a compiled step starts silently returning wrong answers.
 *
 * Outcomes are recorded as `routine_hit`, `routine_deopt_guard`, or
 * `routine_deopt_error` (see {@link routineOutcomes}). Hits and deopts feed
 * `observed` before/after measurement only. This helper mints nothing: no
 * receipt line, no metering change, no cost math, no savings claim of any
 * basis.
 *
 * The routine's `impl` output is NOT validated — the framework validates no
 * tool's output anywhere, and the determinism dividend's output gate lives in
 * customer CI (spec §4.1.3), not here.
 *
 * Refused at construction: a framework-reserved `cave_` tool name; a subagent
 * tool (its execute is framework-run, so a deopt could not reach the original —
 * fail closed rather than ship a routine that cannot deopt); a tool whose input
 * is a Standard Schema (v1 can only re-check the converted draft-07 JSON
 * Schema, which loses the vendor's refinements and transforms — JSON-schema
 * tools only, Standard Schema support is a follow-up); another routine (the
 * inner one would double-count its own outcomes); and an `async` guard (a guard
 * must answer synchronously — a thenable is truthy, so an async guard would
 * admit everything).
 */
export function routine<TInput, TResult>(
  original: ToolDefinition<TInput, TResult>,
  impl: (input: TInput, signal?: AbortSignal) => TResult | Promise<TResult>,
  opts?: { guard?: (input: TInput) => boolean },
): ToolDefinition<TInput, TResult> {
  if (original.name.startsWith("cave_")) {
    throw new Error(`cave_routine_reserved_tool_name:${original.name}`);
  }
  if (original.runtime !== undefined) {
    throw new Error(`cave_routine_subagent_unsupported:${original.name}`);
  }
  if (Reflect.get(original, TOOL_STANDARD_SCHEMA) === true) {
    throw new Error(`cave_routine_standard_schema_unsupported:${original.name}`);
  }
  const originalSource = Reflect.get(original, TOOL_IMPLEMENTATION_SOURCE);
  if (typeof originalSource === "string" &&
      originalSource.startsWith(ROUTINE_SOURCE_MARKER)) {
    throw new Error(`cave_routine_nested_unsupported:${original.name}`);
  }
  const guard = opts?.guard;
  // A manually returned Promise still deopts safely at runtime (a thenable is
  // not `=== true`); this catches the common `async (input) => …` mistake where
  // the intent is visible at construction.
  if (guard?.constructor?.name === "AsyncFunction") {
    throw new Error(`cave_routine_async_guard_unsupported:${original.name}`);
  }
  const options = {
    name: original.name,
    description: original.description,
    input: original.input,
    effect: original.effect,
    result: original.artifact ?? original.result,
    ...(original.allowRepeat === undefined ? {} : { allowRepeat: original.allowRepeat }),
    timeoutMs: original.timeoutMs,
    async execute(input: unknown, signal?: AbortSignal) {
      let admitted: boolean;
      try {
        admitted = Value.Check(original.input, input) &&
          (guard === undefined || guard(input as TInput) === true);
      } catch {
        // A guard that throws is a rejection, never a crash.
        admitted = false;
      }
      if (!admitted) {
        record(original.name, "routine_deopt_guard");
        return original.execute(input as TInput, signal);
      }
      try {
        const value = await impl(input as TInput, signal);
        record(original.name, "routine_hit");
        return value;
      } catch {
        record(original.name, "routine_deopt_error");
        return original.execute(input as TInput, signal);
      }
    },
  };
  Object.defineProperty(options, TOOL_IMPLEMENTATION_SOURCE, {
    value: ROUTINE_SOURCE_MARKER + Function.prototype.toString.call(impl) +
      (guard === undefined ? "" : `\n${Function.prototype.toString.call(guard)}`),
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return tool(options) as ToolDefinition<TInput, TResult>;
}
