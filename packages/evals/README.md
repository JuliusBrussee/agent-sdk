# `@caveman-ai/evals`

Fail-closed grader engine for agent outputs, trajectories, retrieval, HTTP
results, usage, latency, localization, and model-assisted judgments.

Package exports one taxonomy and one async dispatch function:

```ts
import { grade, type Grader } from "@caveman-ai/evals";

const grader: Grader = {
  type: "tool_sequence",
  tools: ["search", "summarize"],
};

const result = await grade(grader, {
  tool_calls: [{ name: "search" }, { name: "summarize" }],
});

if (!result.passed) throw new Error(result.reason);
```

## Ownership

This package is sole owner of grader names, option types, validation, and
verdict semantics. `@caveman-ai/agent` derives its compiler-safe grader subset
from `Grader` and delegates verdicts to `grade`; it carries no second evaluator
engine. `SUPPORTED_GRADER_TYPES` is an immutable runtime view, so consumers
cannot change compiler evidence validation by mutating shared process state.

## Taxonomy

Twenty-one graders execute locally:

- text: `exact_match`, `contains`, `not_contains`, `regex`, `not_regex`,
  `blocklist`
- structure: `json_schema`, `json_path_assertion`
- tools: `tool_called`, `tool_not_called`, `tool_sequence`,
  `tool_argument_assertion`
- operations: `http_status`, `latency_threshold`, `cost_threshold`,
  `token_threshold`
- quality: `bleu_score`, `rouge_score`, `context_f1`, `localization_f1`
- safety: `no_pii`

Six graders use an explicit network boundary:

- `custom_webhook`
- `llm_judge`, `llm_score`, `llm_category`, `llm_pairwise`,
  `llm_answer_match`

`SUPPORTED_GRADER_TYPES` exposes all 27 canonical names. `modelFamily()` exposes
judge-bias family classification.

## Fail-closed behavior

- Unknown grader types return `passed: false`.
- Missing usage, cost, latency, and token values fail their thresholds.
- Invalid options, schemas, judge replies, localization evidence, and unsafe
  regexes fail. `json_schema` supports `type`, `enum`, `required`, `properties`,
  and `items`; every other keyword fails instead of being ignored.
- Regex inputs and patterns are capped. Matching runs in a disposable worker
  with a 250 ms deadline.
- JSON path traversal ignores inherited prototype keys.
- Model-controlled reason excerpts are bounded and never echo detected PII.

## Network graders

No ambient credentials are read. Callers pass network transports and keys
explicitly. Hostname targets require `resolutionPinnedFetch`; ordinary `fetch`
cannot claim DNS-rebinding containment.

```ts
const result = await grade(
  {
    type: "llm_score",
    rubric: "Answer is supported by supplied evidence.",
    min_score: 0.8,
    gateway_url: "https://gateway.example",
    model: "gpt-5.5",
    api_key: explicitEvalKey,
  },
  candidate,
  {
    subjectModel: "claude-sonnet-4-6",
    resolutionPinnedFetch,
    networkTimeoutMs: 5_000,
  },
);
```

Every outbound request refuses redirects. One deadline covers target checking,
response headers, and body parsing. When `subjectModel` shares judge model
family, model-assisted graders fail before network I/O.

`resolutionPinnedFetch` is a capability boundary, not a built-in resolver. Host
must bind checked address to socket connection. This package does not claim
containment from a plain fetch wrapper.

## Runtime

- Node.js 22.19 or newer
- zero runtime dependencies
- ESM only
- Apache-2.0
