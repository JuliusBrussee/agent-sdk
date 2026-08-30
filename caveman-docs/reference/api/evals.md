# `@caveman-ai/evals` API reference

> Generated from the built type declarations by `node scripts/generate-docs-api.mjs`.
> Do not edit by hand. Version at generation time: `0.1.0`.

Fail-closed deterministic and model-assisted graders for production agent evaluations.

## Entrypoints

| Import specifier | Declarations | Exported symbols |
| --- | --- | --- |
| `@caveman-ai/evals` | `packages/evals/dist/index.d.ts` | 6 |

## `@caveman-ai/evals`

Declaration file: `packages/evals/dist/index.d.ts`.

<details><summary>Symbol index</summary>

- **Interface**: `GradeDeps`, `GradeResult`
- **Type alias**: `Grader`
- **Function**: `grade`, `modelFamily`
- **Variable**: `SUPPORTED_GRADER_TYPES`

</details>

### Interfaces

#### `GradeDeps`

```ts
export interface GradeDeps {
    /** Override for IP-literal network calls. Hostnames never use this capability. */
    fetch?: typeof fetch;
    /**
     * Transport that pins SSRF-approved DNS results through socket connect.
     * Required for hostname targets; naming the capability separately prevents
     * an ordinary fetch wrapper from accidentally claiming rebinding safety.
     */
    resolutionPinnedFetch?: typeof fetch;
    /** Override the SSRF guard. Defaults to an IP-literal classifier (see notes). */
    ssrfCheck?: (url: string) => Promise<{
        allowed: boolean;
        reason: string;
    }>;
    /** One deadline for network headers plus body parsing. Default 10 seconds. */
    networkTimeoutMs?: number;
    /**
     * The model that produced the value under test (the system-under-test). When
     * set, llm_judge fails closed if the judge model shares its family — a known
     * judge-bias pitfall (a model favours its own outputs). Leave unset to skip
     * the check (e.g. deterministic graders that never call a model).
     */
    subjectModel?: string;
}
```

Declared in `packages/evals/dist/index.d.ts`.

#### `GradeResult`

```ts
export interface GradeResult {
    passed: boolean;
    reason: string;
}
```

Declared in `packages/evals/dist/index.d.ts`.

### Type aliases

#### `Grader`

```ts
export type Grader = {
    type: "exact_match";
    expected: unknown;
    /** Default false: compare case-insensitively (today's behaviour). */
    case_sensitive?: boolean;
    /** Default false: strip ASCII punctuation before comparing. */
    remove_punctuation?: boolean;
} | {
    type: "contains";
    fragments: string[];
} | {
    type: "not_contains";
    fragments: string[];
} | {
    type: "regex";
    pattern: string;
} | {
    type: "not_regex";
    pattern: string;
} | {
    type: "blocklist";
    terms: string[];
} | {
    type: "json_schema";
    schema: Record<string, unknown>;
} | {
    type: "json_path_assertion";
    path: string;
    equals?: unknown;
    exists?: boolean;
} | {
    type: "tool_called";
    tools: string[];
} | {
    type: "tool_not_called";
    tools: string[];
} | {
    type: "tool_sequence";
    tools: string[];
} | {
    type: "tool_argument_assertion";
    tool: string;
    path: string;
    equals: unknown;
} | {
    type: "http_status";
    status: number;
} | {
    type: "latency_threshold";
    p95_ms: number;
} | {
    type: "cost_threshold";
    max_usd: number;
} | {
    type: "token_threshold";
    max_tokens: number;
} | {
    type: "bleu_score";
    reference: string;
    threshold?: number;
} | {
    type: "rouge_score";
    reference: string;
    rouge_type?: "rouge_1" | "rouge_l";
    measure?: "precision" | "recall" | "fmeasure";
    threshold?: number;
} | {
    type: "context_f1";
    retrieved: string[];
    expected: string[];
    measure?: "precision" | "recall" | "f1";
    similarity_threshold?: number;
    threshold?: number;
} | {
    type: "no_pii";
    entities?: string[];
} | {
    type: "custom_webhook";
    url: string;
} | {
    type: "localization_f1";
    reference: unknown;
    file_threshold?: number;
    line_threshold?: number;
    threshold?: number;
} | {
    type: "llm_judge";
    rubric: string;
    gateway_url?: string;
    model?: string;
    api_key?: string;
    upstream_key?: string;
} | ({
    type: "llm_score";
    rubric: string;
    min_score: number;
} & JudgeTransport) | ({
    type: "llm_category";
    prompt: string;
    categories: string[];
    passing_categories: string[];
} & JudgeTransport) | ({
    type: "llm_pairwise";
    baseline: string;
    criteria: string;
} & JudgeTransport) | ({
    type: "llm_answer_match";
    expected: string;
} & JudgeTransport);
```

Declared in `packages/evals/dist/index.d.ts`.

### Functions

#### `grade`

```ts
export declare function grade(grader: Grader, value: unknown, deps?: GradeDeps): Promise<GradeResult>;
```

Declared in `packages/evals/dist/index.d.ts`.

#### `modelFamily`

```ts
export declare function modelFamily(model: string): string;
```

Declared in `packages/evals/dist/index.d.ts`.

### Variables & constants

#### `SUPPORTED_GRADER_TYPES`

Immutable public taxonomy used by every build and evidence validator.

```ts
export declare const SUPPORTED_GRADER_TYPES: ReadonlySet<Grader["type"]>;
```

Declared in `packages/evals/dist/index.d.ts`.

