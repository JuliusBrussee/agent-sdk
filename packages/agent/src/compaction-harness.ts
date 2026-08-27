import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  contextSummarySources,
  messagesTokens,
  parseContextSummary,
  renderSummary,
  summarizationInstruction,
  validateContextSummaryTransition,
  type ContextSummary,
  type ContextSummarySource,
} from "./compaction.js";
import {
  evaluateContextSummary,
  type ContextSummaryEvaluation,
  type ExpectedContextAnchor,
} from "./compaction-eval.js";

export interface ContextCompactionFixtureRound {
  readonly messages: readonly AgentMessage[];
  /** Defaults to every message in `messages`. */
  readonly summarizable?: readonly number[];
  /** Cumulative active anchors expected after this round. */
  readonly expected: readonly ExpectedContextAnchor[];
  readonly expectedRecoveryDigests?: readonly string[];
  /** Verbatim tail/pins outside capsule, in estimated tokens. */
  readonly retainedTokens?: number;
}

export interface ContextCompactionFixture {
  readonly id: string;
  readonly rounds: readonly ContextCompactionFixtureRound[];
}

export interface ContextCompactionSummarizerRequest {
  readonly fixtureId: string;
  readonly repetition: number;
  readonly round: number;
  readonly messages: readonly AgentMessage[];
  readonly previous: ContextSummary | undefined;
  readonly sources: readonly ContextSummarySource[];
  readonly instruction: string;
}

/** Adapter seam for provider, local model, replay, or deterministic oracle. */
export type ContextCompactionSummarizer = (
  request: ContextCompactionSummarizerRequest,
) => Promise<string> | string;

export interface ContextCompactionHarnessOptions {
  readonly repetitions?: number;
}

export interface ContextCompactionHarnessRoundResult {
  readonly repetition: number;
  readonly round: number;
  readonly parsed: boolean;
  readonly transitionValid: boolean;
  readonly transitionFailures: readonly string[];
  readonly evaluation: ContextSummaryEvaluation | undefined;
}

export interface ContextCompactionHarnessResult {
  readonly fixtureId: string;
  readonly repetitions: number;
  readonly rounds: number;
  readonly validRounds: number;
  readonly criticalAnchorRecall: number;
  readonly weightedAnchorRecall: number;
  readonly exactRecoveryCoverage: number;
  readonly meanCompressionRatio: number;
  readonly stable: boolean;
  readonly failures: readonly string[];
  readonly results: readonly ContextCompactionHarnessRoundResult[];
}

/**
 * Run repeated, generational compaction against any injected summarizer.
 * Provider credentials and transport remain adapter-owned and explicit.
 */
export async function runContextCompactionHarness(
  fixture: ContextCompactionFixture,
  summarize: ContextCompactionSummarizer,
  options: ContextCompactionHarnessOptions = {},
): Promise<ContextCompactionHarnessResult> {
  if (fixture.id.trim() === "" || fixture.rounds.length === 0) {
    throw new Error("cave_compaction_fixture_invalid");
  }
  const repetitions = options.repetitions ?? 5;
  if (!Number.isSafeInteger(repetitions) || repetitions <= 0) {
    throw new Error("cave_compaction_repetitions_invalid");
  }
  const results: ContextCompactionHarnessRoundResult[] = [];
  const failures: string[] = [];
  for (let repetition = 1; repetition <= repetitions; repetition++) {
    let previous: ContextSummary | undefined;
    let cumulativeSourceTokens = 0;
    for (const [roundIndex, fixtureRound] of fixture.rounds.entries()) {
      const round = roundIndex + 1;
      const indexes = fixtureRound.summarizable ?? fixtureRound.messages.map((_, index) => index);
      const sources = contextSummarySources(fixtureRound.messages, indexes);
      cumulativeSourceTokens += messagesTokens(fixtureRound.messages);
      const instruction = summarizationInstruction(previous, sources);
      let text: string;
      try {
        text = await summarize({
          fixtureId: fixture.id,
          repetition,
          round,
          messages: fixtureRound.messages,
          previous,
          sources,
          instruction,
        });
      } catch (error) {
        const failure = `repetition_${repetition}:round_${round}:adapter:${
          error instanceof Error ? error.message : String(error)
        }`;
        failures.push(failure);
        results.push(Object.freeze({
          repetition,
          round,
          parsed: false,
          transitionValid: false,
          transitionFailures: Object.freeze([failure]),
          evaluation: undefined,
        }));
        previous = undefined;
        continue;
      }
      const summary = parseContextSummary(text);
      if (summary === undefined) {
        const failure = `repetition_${repetition}:round_${round}:parse`;
        failures.push(failure);
        results.push(Object.freeze({
          repetition,
          round,
          parsed: false,
          transitionValid: false,
          transitionFailures: Object.freeze([failure]),
          evaluation: undefined,
        }));
        previous = undefined;
        continue;
      }
      const transition = validateContextSummaryTransition(summary, previous, sources);
      const capsuleTokens = Math.ceil(JSON.stringify(renderSummary(summary)).length / 4);
      const evaluation = evaluateContextSummary(summary, {
        expected: fixtureRound.expected,
        sourceTokens: cumulativeSourceTokens,
        compactedTokens: capsuleTokens + (fixtureRound.retainedTokens ?? 0),
        ...(fixtureRound.expectedRecoveryDigests === undefined
          ? {}
          : { expectedRecoveryDigests: fixtureRound.expectedRecoveryDigests }),
      });
      const prefix = `repetition_${repetition}:round_${round}`;
      if (!transition.ok) {
        failures.push(...transition.failures.map((failure) => `${prefix}:${failure}`));
      }
      if (!evaluation.stable) failures.push(`${prefix}:evaluation`);
      results.push(Object.freeze({
        repetition,
        round,
        parsed: true,
        transitionValid: transition.ok,
        transitionFailures: transition.failures,
        evaluation,
      }));
      previous = transition.ok ? summary : undefined;
    }
  }
  const evaluations = results.flatMap((result) =>
    result.evaluation === undefined ? [] : [result.evaluation]);
  const expectedRounds = repetitions * fixture.rounds.length;
  const validRounds = results.filter((result) =>
    result.parsed && result.transitionValid && result.evaluation?.stable === true).length;
  return Object.freeze({
    fixtureId: fixture.id,
    repetitions,
    rounds: expectedRounds,
    validRounds,
    criticalAnchorRecall: mean(evaluations.map((item) => item.criticalAnchorRecall)),
    weightedAnchorRecall: mean(evaluations.map((item) => item.weightedAnchorRecall)),
    exactRecoveryCoverage: mean(evaluations.map((item) => item.exactRecoveryCoverage)),
    meanCompressionRatio: mean(evaluations.map((item) => item.compressionRatio)),
    stable: validRounds === expectedRounds && failures.length === 0,
    failures: Object.freeze(failures),
    results: Object.freeze(results),
  });
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}
