import {
  SUPPORTED_GRADER_TYPES,
  grade,
  modelFamily,
  type GradeDeps,
  type Grader,
  type GradeResult,
} from "../src/index.js";

const grader = {
  type: "exact_match",
  expected: "ok",
} satisfies Grader;

const deps = {
  subjectModel: "claude-sonnet-4-6",
  networkTimeoutMs: 1_000,
} satisfies GradeDeps;

const pending: Promise<GradeResult> = grade(grader, "ok", deps);
void pending;
void modelFamily("gpt-5.5");
void SUPPORTED_GRADER_TYPES.has("exact_match");

// @ts-expect-error Canonical taxonomy is immutable to consumers.
SUPPORTED_GRADER_TYPES.add("regex");

// @ts-expect-error Unknown grader names are rejected by public taxonomy.
const unknown: Grader = { type: "unknown" };
void unknown;

// @ts-expect-error Cost thresholds require numeric max_usd.
const malformed: Grader = { type: "cost_threshold", max_usd: "1" };
void malformed;
