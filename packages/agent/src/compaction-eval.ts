import {
  validateContextSummaryTransition,
  type ContextAnchorKind,
  type ContextSummary,
  type ContextSummarySource,
} from "./compaction.js";

export interface ExpectedContextAnchor {
  readonly key?: string;
  readonly kind: ContextAnchorKind;
  readonly text: string;
  readonly critical?: boolean;
  readonly weight?: number;
}

export interface ContextSummaryEvaluationInput {
  readonly expected: readonly ExpectedContextAnchor[];
  readonly sourceTokens: number;
  readonly compactedTokens: number;
  readonly expectedRecoveryDigests?: readonly string[];
}

export interface ContextSummaryEvaluation {
  readonly criticalAnchorRecall: number;
  readonly weightedAnchorRecall: number;
  readonly exactRecoveryCoverage: number;
  readonly compressionRatio: number;
  readonly commitmentDensity: number;
  readonly stable: boolean;
}

/** Exact-match evaluator. Paraphrase is drift for paths, commands, and contracts. */
export function evaluateContextSummary(
  summary: ContextSummary,
  input: ContextSummaryEvaluationInput,
): ContextSummaryEvaluation {
  validateTokenCount(input.sourceTokens);
  validateTokenCount(input.compactedTokens);
  const weighted = input.expected.map((expected) => ({
    expected,
    weight: expected.weight ?? 1,
    matched: summary.anchors.some((anchor) =>
      (expected.key === undefined || anchor.key === expected.key) &&
      anchor.kind === expected.kind && anchor.text === expected.text),
  }));
  if (weighted.some((item) => !Number.isFinite(item.weight) || item.weight <= 0)) {
    throw new Error("cave_compaction_eval_weight_invalid");
  }
  const critical = weighted.filter((item) => item.expected.critical === true);
  const criticalAnchorRecall = ratio(
    critical.filter((item) => item.matched).length,
    critical.length,
  );
  const weightTotal = weighted.reduce((total, item) => total + item.weight, 0);
  const weightMatched = weighted.reduce(
    (total, item) => total + (item.matched ? item.weight : 0), 0,
  );
  const expectedDigests = input.expectedRecoveryDigests ?? [];
  const cited = new Set(summary.citations.map((citation) => citation.digest));
  const exactRecoveryCoverage = ratio(
    expectedDigests.filter((digest) => cited.has(digest)).length,
    expectedDigests.length,
  );
  const compressionRatio = input.compactedTokens === 0
    ? Number.POSITIVE_INFINITY
    : input.sourceTokens / input.compactedTokens;
  const criticalMatches = critical.filter((item) => item.matched).length;
  const commitmentDensity = criticalMatches / Math.max(1, input.compactedTokens);
  const weightedAnchorRecall = ratio(weightMatched, weightTotal);
  return Object.freeze({
    criticalAnchorRecall,
    weightedAnchorRecall,
    exactRecoveryCoverage,
    compressionRatio,
    commitmentDensity,
    stable: criticalAnchorRecall === 1 && weightedAnchorRecall === 1 &&
      exactRecoveryCoverage === 1 && input.compactedTokens < input.sourceTokens,
  });
}

export interface ContextSummaryRound {
  readonly summary: ContextSummary;
  readonly sources: readonly ContextSummarySource[];
}

export interface ContextSummaryStability {
  readonly rounds: number;
  readonly validTransitions: number;
  readonly criticalAnchorRetention: number;
  readonly stable: boolean;
  readonly failures: readonly string[];
}

/** Validate a repeated-compaction series, including generation and anchor drift. */
export function evaluateContextSummaryStability(
  rounds: readonly ContextSummaryRound[],
): ContextSummaryStability {
  const failures: string[] = [];
  let validTransitions = 0;
  let criticalExpected = 0;
  let criticalRetained = 0;
  let previous: ContextSummary | undefined;
  for (const [index, round] of rounds.entries()) {
    const result = validateContextSummaryTransition(round.summary, previous, round.sources);
    if (result.ok) validTransitions++;
    else failures.push(...result.failures.map((failure) => `round_${index + 1}:${failure}`));
    if (previous !== undefined) {
      const sources = new Map(round.sources.map((source) => [source.segmentId, source]));
      for (const anchor of previous.anchors.filter((item) => item.critical)) {
        criticalExpected++;
        const retained = round.summary.anchors.some((candidate) =>
          candidate.key === anchor.key && candidate.kind === anchor.kind &&
          candidate.text === anchor.text && candidate.critical === anchor.critical &&
          candidate.sourceSegmentId === anchor.sourceSegmentId &&
          candidate.sourceDigest === anchor.sourceDigest &&
          candidate.supersedes.length === anchor.supersedes.length &&
          candidate.supersedes.every((key, keyIndex) => key === anchor.supersedes[keyIndex]));
        const superseded = round.summary.anchors.some((candidate) => {
          const source = sources.get(candidate.sourceSegmentId);
          return candidate.critical && candidate.supersedes.includes(anchor.key) &&
            source?.role === "user" && source.digest === candidate.sourceDigest;
        });
        if (retained || superseded) {
          criticalRetained++;
        }
      }
    }
    previous = round.summary;
  }
  const criticalAnchorRetention = ratio(criticalRetained, criticalExpected);
  return Object.freeze({
    rounds: rounds.length,
    validTransitions,
    criticalAnchorRetention,
    stable: rounds.length > 0 && validTransitions === rounds.length && criticalAnchorRetention === 1,
    failures: Object.freeze(failures),
  });
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

function validateTokenCount(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("cave_compaction_eval_tokens_invalid");
  }
}
