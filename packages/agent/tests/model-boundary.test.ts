import type { AdapterLifecycleIdentity } from "@caveman-ai/adapter-kit";
import {
  createModelBoundary,
  type ModelBoundaryContext,
} from "../src/model-boundary.js";

const identity = {
  runId: "run-1",
  stepId: "step-1",
  modelCallId: "call-1",
  attempt: 1,
  replay: false,
  nativeIds: {},
} satisfies AdapterLifecycleIdentity;

const context: ModelBoundaryContext = {
  identity,
  role: "working",
  provider: "openai",
  model: "openai/gpt-test",
  signal: new AbortController().signal,
};

createModelBoundary<string, string>([]).prepare("request", context);

const missingIdentity: ModelBoundaryContext = {
  // @ts-expect-error canonical lifecycle identity is required
  identity: undefined,
  role: "working",
  provider: "openai",
  model: "openai/gpt-test",
  signal: new AbortController().signal,
};

const missingModelCallId: ModelBoundaryContext = {
  // @ts-expect-error model boundaries require a canonical model-call scope
  identity: { ...identity, modelCallId: undefined },
  role: "working",
  provider: "openai",
  model: "openai/gpt-test",
  signal: new AbortController().signal,
};

const legacyCallId: ModelBoundaryContext = {
  identity,
  // @ts-expect-error parallel callId identity was removed
  callId: "parallel-call-id",
  role: "working",
  provider: "openai",
  model: "openai/gpt-test",
  signal: new AbortController().signal,
};

void missingIdentity;
void missingModelCallId;
void legacyCallId;
