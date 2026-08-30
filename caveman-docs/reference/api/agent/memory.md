# `@caveman-ai/agent/memory`

> Generated from the built type declarations by `node scripts/generate-docs-api.mjs`.
> Do not edit by hand. Version at generation time: `0.2.0`.

Declaration file: `packages/agent/dist/memory-api.d.ts`.

<details><summary>Symbol index</summary>

- **Class**: `MemoryEngine`
- **Interface**: `CompletionMemorySidecarOptions`, `CreateMemoryEngineOptions`, `MemoryAmbientOptions`, `MemoryCompletionRequest`, `MemoryConsolidationInput`, `MemoryDraft`, `MemoryEdge`, `MemoryEmbeddingAdapter`, `MemoryExtractionInput`, `MemoryHit`, `MemoryRecall`, `MemoryRecord`, `MemoryRememberInput`, `MemoryReviewInput`, `MemoryReviewResult`, `MemoryRuntimeConfig`, `MemoryScope`, `MemorySearchOptions`, `MemorySessionHit`, `MemorySidecarAdapter`, `MemorySource`, `MemoryState`, `MemoryStorageAdapter`, `MemoryStoreConfig`, `MemoryTurn`, `MemoryTurnInput`, `MemoryVector`, `OpenAICompatibleMemoryEmbeddingOptions`
- **Type alias**: `MemoryKind`, `MemoryRelation`
- **Function**: `completionMemorySidecar`, `cosine`, `createFileMemoryAdapter`, `createInMemoryMemoryStorage`, `createMemoryEngine`, `createMemoryWorkflow`, `createSparseEmbeddingAdapter`, `emptyMemoryState`, `memoryFilePath`, `openAICompatibleMemoryEmbedding`, `packVector`, `readMemoryState`

</details>

## Classes

### `MemoryEngine`

```ts
export declare class MemoryEngine {
    readonly scope: MemoryScope;
    readonly storage: MemoryStorageAdapter;
    readonly embedding: MemoryEmbeddingAdapter | undefined;
    private readonly sidecar;
    private readonly ttlMs;
    private readonly recallTokens;
    private readonly maxResults;
    private readonly minScore;
    private readonly graphDepth;
    private readonly maxSessionTurns;
    private readonly ambient;
    private readonly now;
    private readonly onError;
    private readonly allowStore;
    private readonly sessions;
    private readonly pending;
    private tail;
    private writesSinceConsolidation;
    private consolidating;
    constructor(options: CreateMemoryEngineOptions);
    /**
     * Zero-latency passive seam. Returns completed recall from prior turn, then
     * queues current turn. Slow embeddings or sidecars never delay main agent.
     */
    beginTurn(input: MemoryTurnInput): MemoryRecall | undefined;
    /** Queues assistant response for session RAG and ambient extraction. */
    endTurn(input: MemoryTurnInput): void;
    /** Waits only when caller deliberately closes/flushes session. */
    endSession(sessionId: string, signal?: AbortSignal): Promise<void>;
    flush(): Promise<void>;
    remember(input: MemoryRememberInput, signal?: AbortSignal): Promise<MemoryRecord>;
    search(query: string, options?: MemorySearchOptions): Promise<readonly MemoryHit[]>;
    recall(query: string, options?: MemorySearchOptions): Promise<MemoryRecall>;
    searchSessions(query: string, options?: Omit<MemorySearchOptions, "graphDepth">): Promise<readonly MemorySessionHit[]>;
    forget(id: string): Promise<boolean>;
    link(from: string, to: string, relation: MemoryRelation, weight?: number): Promise<void>;
    consolidate(signal?: AbortSignal): Promise<void>;
    private enqueue;
    private processTurn;
    private extract;
    private reinforceRecall;
    private embedOne;
    private assertStoreAllowed;
    private canStore;
    private report;
}
```

Declared in `packages/agent/dist/memory.d.ts`.

## Interfaces

### `CompletionMemorySidecarOptions`

```ts
export interface CompletionMemorySidecarOptions {
    readonly complete: (request: MemoryCompletionRequest) => Promise<string>;
}
```

Declared in `packages/agent/dist/memory-adapters.d.ts`.

### `CreateMemoryEngineOptions`

```ts
export interface CreateMemoryEngineOptions {
    readonly scope: MemoryScope;
    readonly storage?: MemoryStorageAdapter;
    /** Default is dependency-free sparse cosine. Supply a semantic adapter to upgrade recall. */
    readonly embedding?: MemoryEmbeddingAdapter | false;
    readonly sidecar?: MemorySidecarAdapter;
    readonly ttlMs: number;
    readonly recallTokens?: number;
    readonly maxResults?: number;
    readonly minScore?: number;
    readonly graphDepth?: number;
    readonly maxSessionTurns?: number;
    readonly ambient?: false | MemoryAmbientOptions;
    readonly now?: () => number;
    readonly onError?: (error: Error) => void;
    /** Extra application policy. Returning false refuses persistence. */
    readonly allowStore?: (text: string) => boolean;
}
```

Declared in `packages/agent/dist/memory.d.ts`.

### `MemoryAmbientOptions`

```ts
export interface MemoryAmbientOptions {
    /** Assistant turns between extraction passes. Defaults to 8. */
    readonly extractEveryTurns?: number;
    /** Extract old topic when user-vector similarity drops below this. Defaults to 0.35. */
    readonly driftThreshold?: number;
    /** New memories between deep consolidation passes. Defaults to 32. */
    readonly consolidateEveryWrites?: number;
}
```

Declared in `packages/agent/dist/memory.d.ts`.

### `MemoryCompletionRequest`

```ts
export interface MemoryCompletionRequest {
    readonly purpose: "review" | "extract" | "consolidate";
    readonly system: string;
    readonly input: string;
    readonly signal?: AbortSignal;
}
```

Declared in `packages/agent/dist/memory-adapters.d.ts`.

### `MemoryConsolidationInput`

```ts
export interface MemoryConsolidationInput {
    readonly memories: readonly MemoryRecord[];
    readonly edges: readonly MemoryEdge[];
}
```

Declared in `packages/agent/dist/memory.d.ts`.

### `MemoryDraft`

```ts
export interface MemoryDraft {
    readonly text: string;
    readonly kind?: MemoryKind;
    readonly tags?: readonly string[];
    readonly confidence?: number;
    readonly supersedes?: readonly string[];
    readonly contradicts?: readonly string[];
}
```

Declared in `packages/agent/dist/memory.d.ts`.

### `MemoryEdge`

```ts
export interface MemoryEdge {
    readonly from: string;
    readonly to: string;
    readonly relation: MemoryRelation;
    readonly weight: number;
    readonly createdAt: number;
}
```

Declared in `packages/agent/dist/memory.d.ts`.

### `MemoryEmbeddingAdapter`

```ts
export interface MemoryEmbeddingAdapter {
    /** Stable model/vector-space identity. Different ids are never compared. */
    readonly id: string;
    embed(texts: readonly string[], signal?: AbortSignal): Promise<readonly (readonly number[])[]>;
}
```

Declared in `packages/agent/dist/memory.d.ts`.

### `MemoryExtractionInput`

```ts
export interface MemoryExtractionInput {
    readonly sessionId: string;
    readonly turns: readonly MemoryTurn[];
    readonly existing: readonly MemoryRecord[];
    readonly reason: "turns" | "drift" | "session_end";
}
```

Declared in `packages/agent/dist/memory.d.ts`.

### `MemoryHit`

```ts
export interface MemoryHit {
    readonly id: string;
    readonly text: string;
    readonly kind: MemoryKind;
    readonly tags: readonly string[];
    readonly score: number;
    readonly confidence: number;
    readonly source: "vector" | "lexical" | "graph";
}
```

Declared in `packages/agent/dist/memory.d.ts`.

### `MemoryRecall`

```ts
export interface MemoryRecall {
    readonly query: string;
    readonly hits: readonly MemoryHit[];
    readonly prompt: string;
    readonly basis: "inferred";
    readonly sidecarContext?: string;
}
```

Declared in `packages/agent/dist/memory.d.ts`.

### `MemoryRecord`

```ts
export interface MemoryRecord {
    readonly id: string;
    readonly text: string;
    readonly kind: MemoryKind;
    readonly tags: readonly string[];
    readonly createdAt: number;
    readonly updatedAt: number;
    readonly expiresAt: number;
    readonly confidence: number;
    readonly strength: number;
    readonly active: boolean;
    readonly sources: readonly MemorySource[];
    readonly vector?: MemoryVector;
}
```

Declared in `packages/agent/dist/memory.d.ts`.

### `MemoryRememberInput`

```ts
export interface MemoryRememberInput {
    readonly text: string;
    readonly kind?: MemoryKind;
    readonly tags?: readonly string[];
    readonly confidence?: number;
    readonly sessionId?: string;
    readonly turnId?: string;
    readonly supersedes?: readonly string[];
    readonly contradicts?: readonly string[];
}
```

Declared in `packages/agent/dist/memory.d.ts`.

### `MemoryReviewInput`

```ts
export interface MemoryReviewInput {
    readonly query: string;
    readonly candidates: readonly MemoryHit[];
}
```

Declared in `packages/agent/dist/memory.d.ts`.

### `MemoryReviewResult`

```ts
export interface MemoryReviewResult {
    readonly ids: readonly string[];
    /** Optional bounded result of sidecar-owned deeper retrieval. Still untrusted. */
    readonly context?: string;
}
```

Declared in `packages/agent/dist/memory.d.ts`.

### `MemoryRuntimeConfig`

```ts
export interface MemoryRuntimeConfig extends MemoryStoreConfig {
    /** Reuse one engine across turns. Pebble and adapters do this automatically. */
    readonly engine?: MemoryEngine;
    /** Custom durable backend. Omit for private atomic local JSON. */
    readonly storage?: MemoryStorageAdapter;
    readonly embedding?: MemoryEmbeddingAdapter | false;
    readonly sidecar?: MemorySidecarAdapter;
    readonly onError?: (error: Error) => void;
    /** Extra application policy. Returning false refuses all turn and explicit persistence. */
    readonly allowStore?: (text: string) => boolean;
}
```

Declared in `packages/agent/dist/memory.d.ts`.

### `MemoryScope`

```ts
export interface MemoryScope {
    readonly tenant: string;
    readonly agentId: string;
    readonly namespace: string;
}
```

Declared in `packages/agent/dist/memory.d.ts`.

### `MemorySearchOptions`

```ts
export interface MemorySearchOptions {
    readonly maxResults?: number;
    readonly minScore?: number;
    readonly graphDepth?: number;
    readonly exclude?: ReadonlySet<string>;
    readonly signal?: AbortSignal;
}
```

Declared in `packages/agent/dist/memory.d.ts`.

### `MemorySessionHit`

```ts
export interface MemorySessionHit {
    readonly id: string;
    readonly sessionId: string;
    readonly sequence: number;
    readonly role: "user" | "assistant";
    readonly text: string;
    readonly score: number;
    readonly source: "vector" | "lexical";
}
```

Declared in `packages/agent/dist/memory.d.ts`.

### `MemorySidecarAdapter`

Optional small-model seam. Nothing invokes another model unless supplied.

```ts
export interface MemorySidecarAdapter {
    review?(input: MemoryReviewInput, signal?: AbortSignal): Promise<readonly string[] | MemoryReviewResult>;
    extract?(input: MemoryExtractionInput, signal?: AbortSignal): Promise<readonly MemoryDraft[]>;
    consolidate?(input: MemoryConsolidationInput, signal?: AbortSignal): Promise<readonly MemoryDraft[]>;
}
```

Declared in `packages/agent/dist/memory.d.ts`.

### `MemorySource`

```ts
export interface MemorySource {
    readonly sessionId: string;
    readonly turnId?: string;
    readonly at: number;
}
```

Declared in `packages/agent/dist/memory.d.ts`.

### `MemoryState`

```ts
export interface MemoryState {
    readonly schemaVersion: 1;
    readonly revision: number;
    readonly memories: readonly MemoryRecord[];
    readonly turns: readonly MemoryTurn[];
    readonly edges: readonly MemoryEdge[];
}
```

Declared in `packages/agent/dist/memory.d.ts`.

### `MemoryStorageAdapter`

```ts
export interface MemoryStorageAdapter {
    read(scope: MemoryScope): Promise<MemoryState>;
    update(scope: MemoryScope, mutate: (state: MemoryState) => MemoryState): Promise<MemoryState>;
}
```

Declared in `packages/agent/dist/memory.d.ts`.

### `MemoryStoreConfig`

Where durable memory lives, and for whom. Threaded from
`RunOptions.memory` so an embedding server can point at its own location AND
scope per tenant, so two tenants sharing an agent id + namespace never see
each other's memories.

```ts
export interface MemoryStoreConfig {
    /**
     * Base directory. Defaults to `CAVE_AGENT_MEMORY_ROOT`, else
     * `~/.caveman/agent-memory`. A stable location so a 30-day ttl survives
     * reboots, not just process restarts.
     */
    readonly root?: string;
    /** Tenant scope. Defaults to `_` (single-tenant). Isolates per tenant. */
    readonly tenant?: string;
}
```

Declared in `packages/agent/dist/memory-store.d.ts`.

### `MemoryTurn`

```ts
export interface MemoryTurn {
    readonly id: string;
    readonly sessionId: string;
    readonly sequence: number;
    readonly role: "user" | "assistant";
    readonly text: string;
    readonly createdAt: number;
    readonly vector?: MemoryVector;
}
```

Declared in `packages/agent/dist/memory.d.ts`.

### `MemoryTurnInput`

```ts
export interface MemoryTurnInput {
    readonly sessionId: string;
    readonly text: string;
    readonly turnId?: string;
}
```

Declared in `packages/agent/dist/memory.d.ts`.

### `MemoryVector`

Quantized vector. JSON stays small enough for a local, dependency-free adapter.

```ts
export interface MemoryVector {
    readonly adapter: string;
    readonly dimensions: number;
    readonly scale: number;
    readonly data: string;
}
```

Declared in `packages/agent/dist/memory.d.ts`.

### `OpenAICompatibleMemoryEmbeddingOptions`

```ts
export interface OpenAICompatibleMemoryEmbeddingOptions {
    /** API root such as `https://api.openai.com/v1` or a local compatible server. */
    readonly baseURL: string;
    readonly model: string;
    /** Explicit credential only. Adapter never reads ambient environment variables. */
    readonly apiKey?: string;
    readonly dimensions?: number;
    readonly fetch?: typeof globalThis.fetch;
}
```

Declared in `packages/agent/dist/memory-adapters.d.ts`.

## Type aliases

### `MemoryKind`

```ts
export type MemoryKind = "fact" | "preference" | "procedure" | "correction" | "decision";
```

Declared in `packages/agent/dist/memory.d.ts`.

### `MemoryRelation`

```ts
export type MemoryRelation = "relates_to" | "supersedes" | "contradicts" | "derived_from";
```

Declared in `packages/agent/dist/memory.d.ts`.

## Functions

### `completionMemorySidecar`

Turns any small structured-output model into memory sidecar. Parser accepts
strict JSON only; unknown ids, fields, kinds, or oversized output fail closed.

```ts
export declare function completionMemorySidecar(options: CompletionMemorySidecarOptions): MemorySidecarAdapter;
```

Declared in `packages/agent/dist/memory-adapters.d.ts`.

### `cosine`

```ts
export declare function cosine(first: MemoryVector, second: MemoryVector): number;
```

Declared in `packages/agent/dist/memory.d.ts`.

### `createFileMemoryAdapter`

Default dependency-free adapter. Scope chooses tenant/agent/namespace.

```ts
export declare function createFileMemoryAdapter(config?: Pick<MemoryStoreConfig, "root">): MemoryStorageAdapter;
```

Declared in `packages/agent/dist/memory-store.d.ts`.

### `createInMemoryMemoryStorage`

Useful for tests, server adapters, and fully ephemeral workflows.

```ts
export declare function createInMemoryMemoryStorage(): MemoryStorageAdapter;
```

Declared in `packages/agent/dist/memory-adapters.d.ts`.

### `createMemoryEngine`

```ts
export declare function createMemoryEngine(options: CreateMemoryEngineOptions): MemoryEngine;
```

Declared in `packages/agent/dist/memory.d.ts`.

### `createMemoryWorkflow`

Minimal adapter for any agent workflow, independent of provider/framework.

```ts
export declare function createMemoryWorkflow(engine: MemoryEngine, sessionId: string): Readonly<{
    beforeTurn(text: string): string | undefined;
    afterTurn(text: string): void;
    search(query: string, options?: MemorySearchOptions): Promise<readonly MemoryHit[]>;
    remember(input: string | MemoryRememberInput, signal?: AbortSignal): Promise<MemoryRecord>;
    searchSessions(query: string, options?: Omit<MemorySearchOptions, "graphDepth">): Promise<readonly MemorySessionHit[]>;
    close(signal?: AbortSignal): Promise<void>;
}>;
```

Declared in `packages/agent/dist/memory.d.ts`.

### `createSparseEmbeddingAdapter`

Dependency-free fallback. Sparse lexical vector, not claimed as semantic.

```ts
export declare function createSparseEmbeddingAdapter(dimensions?: number): MemoryEmbeddingAdapter;
```

Declared in `packages/agent/dist/memory.d.ts`.

### `emptyMemoryState`

```ts
export declare function emptyMemoryState(): MemoryState;
```

Declared in `packages/agent/dist/memory.d.ts`.

### `memoryFilePath`

The durable file for (tenant, agentId, namespace). The three scoping
components are validated to a `[a-z0-9_-]`-class charset with no `.` or path
separator, so no component can traverse out of the memory root.

```ts
export declare function memoryFilePath(config: MemoryStoreConfig | undefined, agentId: string, namespace: string): string;
```

Declared in `packages/agent/dist/memory-store.d.ts`.

### `openAICompatibleMemoryEmbedding`

Lazy, fetch-only embedding adapter. Adds no provider SDK dependency.

```ts
export declare function openAICompatibleMemoryEmbedding(options: OpenAICompatibleMemoryEmbeddingOptions): MemoryEmbeddingAdapter;
```

Declared in `packages/agent/dist/memory-adapters.d.ts`.

### `packVector`

```ts
export declare function packVector(adapter: string, input: readonly number[]): MemoryVector;
```

Declared in `packages/agent/dist/memory.d.ts`.

### `readMemoryState`

Read v1 state, migrating the original entry-array shape in memory.

```ts
export declare function readMemoryState(filePath: string): Promise<MemoryState>;
```

Declared in `packages/agent/dist/memory-store.d.ts`.

