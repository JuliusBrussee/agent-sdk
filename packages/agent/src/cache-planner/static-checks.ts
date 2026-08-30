// Static plan checks + their failure voice (Agent SDK v2 phase 2, F2).
//
// Ordering contract (goldens/README.md): these run in `caveman-agent build`
// BEFORE model-backed evals — they are free and deterministic, so a build
// without evals still fails fast on a static violation instead of printing
// `needs_eval`. Renderers are pure functions over structured diagnostics; the
// goldens under goldens/failures/ pin their exact bytes (fixture-pinned fields
// the live pipeline cannot know, like an agent.ts line number, are filled by
// the fixture — the live checks fill only what they actually know and never
// fabricate). Wire codes are demoted to --verbose; default output has none.
import { catalogCacheProfile } from "../catalog.js";
import type { ContextIR, ContextSegment } from "../context-ir.js";

export interface VolatilePrefixDiagnostic {
  code: "cave_frozen_prefix_volatile_segment";
  /** e.g. "agent.ts:8" from a fixture; the live check knows only "agent.ts". */
  location: string;
  segmentId: string;
  stability: string;
  /** Single-line source of the offending context value, when known. */
  sourcePreview?: string;
  /** Suggested tool filename for the fix (a suggestion, not an existing file). */
  fixToolPath: string;
}

export interface PrefixShrinkDiagnostic {
  code: "cave_prefix_shrink_regression";
  lockedTokens: number;
  currentTokens: number;
}

export interface PrefixBelowMinimumDiagnostic {
  code: "cave_frozen_prefix_below_provider_minimum";
  prefixTokens: number;
  minimumTokens: number;
  /** Bare model name (no provider prefix), as the provider names it. */
  model: string;
}

export type StaticPlanFailure =
  | VolatilePrefixDiagnostic
  | PrefixShrinkDiagnostic
  | PrefixBelowMinimumDiagnostic;

/** Frozen-prefix segments of a lowered Context IR, in order. */
export function frozenPrefixSegments(ir: ContextIR): ContextSegment[] {
  return ir.segments.filter((segment) => segment.cacheRegion === "frozen_prefix");
}

/** Estimated token count of the frozen prefix (same estimate the IR carries). */
export function frozenPrefixTokens(ir: ContextIR): number {
  return frozenPrefixSegments(ir).reduce((sum, segment) => sum + segment.tokenCount, 0);
}

/**
 * The #224 first half: two independent composition passes must lower to a
 * byte-identical frozen prefix. Returns the first frozen segment whose bytes
 * differ between the passes (or whose presence differs), else undefined.
 */
export function findVolatileFrozenSegment(
  first: ContextIR,
  second: ContextIR,
): Pick<ContextSegment, "id" | "stability"> | undefined {
  const a = frozenPrefixSegments(first);
  const b = frozenPrefixSegments(second);
  const count = Math.max(a.length, b.length);
  for (let index = 0; index < count; index++) {
    const left = a[index];
    const right = b[index];
    if (left === undefined || right === undefined || left.id !== right.id) {
      const present = left ?? right!;
      return { id: present.id, stability: present.stability };
    }
    if (left.provenanceDigest !== right.provenanceDigest) {
      return { id: left.id, stability: left.stability };
    }
  }
  return undefined;
}

/**
 * Provider minimum cacheable prefix length for a "provider/model" id, from the
 * catalog's cache profiles. Unknown model or profile → undefined (the check
 * honestly cannot fire; unpriced-model handling lives elsewhere). `mode`
 * scopes severity (goldens/README.md): explicit-cache models FAIL below the
 * minimum — the lock would promise breakpoints over a cache that cannot
 * exist — while affinity/implicit models get a loud advisory instead.
 */
export function providerPrefixMinimum(
  model: string,
): { minimumTokens: number; model: string; mode: string } | undefined {
  const slash = model.indexOf("/");
  if (slash <= 0) return undefined;
  const provider = model.slice(0, slash);
  const bare = model.slice(slash + 1);
  const profile = catalogCacheProfile(provider, bare);
  if (profile === undefined || profile.minPrefixTokens <= 0) return undefined;
  return { minimumTokens: profile.minPrefixTokens, model: bare, mode: profile.mode };
}

/**
 * The advisory line for affinity/implicit models below their automatic-cache
 * minimum: the runs still work, they just read cold, and the output says so.
 */
export function renderBelowMinimumAdvisory(diagnostic: {
  prefixTokens: number;
  minimumTokens: number;
  model: string;
}): string {
  return `prefix ≈${formatTokens(diagnostic.prefixTokens)} tokens is below ` +
    `${diagnostic.model}'s automatic-cache minimum (${formatTokens(diagnostic.minimumTokens)}) ` +
    "— runs will read cold; receipts will show 0 warm\n";
}

export const VOLATILITY_CLOCK_SHIFT_MS = 26 * 60 * 60 * 1000;

/**
 * Runs `work` with `globalThis.Date` shifted +26h, restoring it in a finally.
 * The volatile-prefix check runs its SECOND composition pass under this clock
 * so day-stable values (`toDateString()`) are caught, not just per-call ones.
 * The patch is process-global for the duration of `work`; the build pipeline
 * is sequential there, and nothing else observes wall time mid-composition.
 */
export async function withPerturbedClock<T>(work: () => Promise<T>): Promise<T> {
  const RealDate = globalThis.Date;
  const PerturbedDate = class extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(RealDate.now() + VOLATILITY_CLOCK_SHIFT_MS);
      else super(...(args as ConstructorParameters<DateConstructor>));
    }
    static override now(): number {
      return RealDate.now() + VOLATILITY_CLOCK_SHIFT_MS;
    }
  };
  globalThis.Date = PerturbedDate as DateConstructor;
  try {
    return await work();
  } finally {
    globalThis.Date = RealDate;
  }
}

function formatTokens(value: number): string {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Renders a static-plan failure in the F2 voice: plain-words sentence first,
 * mechanism second, fix third. The wire code appears only with `verbose`.
 */
export function renderStaticPlanFailure(
  failure: StaticPlanFailure,
  options: { verbose?: boolean } = {},
): string {
  let rendered: string;
  switch (failure.code) {
    case "cave_frozen_prefix_volatile_segment":
      rendered = renderVolatilePrefix(failure);
      break;
    case "cave_prefix_shrink_regression":
      rendered = renderPrefixShrink(failure);
      break;
    case "cave_frozen_prefix_below_provider_minimum":
      rendered = renderPrefixBelowMinimum(failure);
      break;
  }
  if (options.verbose === true) rendered += `\n  wire code: ${failure.code}\n`;
  return rendered;
}

function renderVolatilePrefix(failure: VolatilePrefixDiagnostic): string {
  const heading = `  ${failure.location}   context ${JSON.stringify(failure.segmentId)} ` +
    `(stability: ${JSON.stringify(failure.stability)})`;
  const continuation = " ".repeat(2 + failure.location.length + 3);
  return [
    "✗ build failed: your frozen prefix changes between runs",
    "",
    heading,
    ...(failure.sourcePreview === undefined ? [] : [`${continuation}${failure.sourcePreview}`]),
    "",
    "  This segment is declared build-stable, so it sits in the cacheable",
    "  frozen prefix — but its bytes came out different on two build passes.",
    "  A prefix that changes between runs makes the provider re-read your",
    "  full instructions at cold input price on every turn instead of a",
    "  warm cache read.",
    "",
    "  Fix: run-varying values belong in the live zone —",
    "    declare the segment `stability: \"turn\"`, or serve it from a tool",
    `    (${failure.fixToolPath}).`,
    "",
    "  A plan that breaks the provider cache never locks, even when it lowers",
    "  raw token count.",
    "",
  ].join("\n");
}

function renderPrefixShrink(failure: PrefixShrinkDiagnostic): string {
  const locked = formatTokens(failure.lockedTokens);
  const current = formatTokens(failure.currentTokens);
  const delta = formatTokens(failure.lockedTokens - failure.currentTokens);
  const width = Math.max(locked.length, current.length);
  return [
    "✗ build failed: this change shrinks your cacheable prefix",
    "",
    `  ${"locked plan".padEnd(11)}    ${locked.padStart(width)} tok frozen prefix`,
    `  ${"this build".padEnd(11)}    ${current.padStart(width)} tok frozen prefix (−${delta})`,
    "  token figures are local estimates — the same basis the build plans with",
    "",
    `  Raw token count went down, but ${delta} tokens moved out of the frozen`,
    "  prefix into the live zone. The provider re-reads live-zone tokens at",
    "  cold input price on every turn, so the warm-read cost of this agent",
    '  went up even though it "got smaller".',
    "",
    "  Fix: keep static prose in instructions.md and skills/ — only",
    "  run-varying values belong in the live zone. If the moved content is",
    '  genuinely static, mark its stability "build". If the shrink is',
    "  intentional — you deleted prose on purpose — rerun with",
    "  `--accept-prefix-shrink` to reset the baseline.",
    "",
    "  A plan that regresses warm-read cost never locks, even when it lowers",
    "  raw token count.",
    "",
  ].join("\n");
}

function renderPrefixBelowMinimum(failure: PrefixBelowMinimumDiagnostic): string {
  const prefix = `≈${formatTokens(failure.prefixTokens)}`;
  const minimum = formatTokens(failure.minimumTokens);
  const width = Math.max(prefix.length, minimum.length);
  return [
    "✗ build failed: your frozen prefix is too small for the provider to cache",
    "",
    `  ${"frozen prefix".padEnd(16)}  ${prefix.padStart(width)} tokens (local estimate)`,
    `  ${"provider minimum".padEnd(16)}  ${minimum.padStart(width)} tokens (${failure.model})`,
    "",
    "  The provider only caches prefixes at or above its minimum length.",
    "  Below it, every run reads your instructions cold, and the warm-read",
    "  economics this build exists to lock never start — the lock would be",
    "  a promise about a cache that will never exist.",
    "",
    "  Fix: one of —",
    "    · move more of the agent's genuinely static prose into",
    "      instructions.md or skills/ descriptions (never padding — if the",
    "      agent doesn't need it, it shouldn't be there)",
    "    · pick a model with a lower cache minimum",
    "    · skip the lock: `npm run dev` and `npm run ticket` work fine",
    "      uncached, and a prefix this small is also cheap to read cold",
    "",
    "  This check runs before any model-backed eval, so failure spends $0.",
    "",
  ].join("\n");
}
