import {
  emptyMemoryState,
  type MemoryDraft,
  type MemoryEmbeddingAdapter,
  type MemoryConsolidationInput,
  type MemoryExtractionInput,
  type MemoryKind,
  type MemoryReviewInput,
  type MemoryScope,
  type MemorySidecarAdapter,
  type MemoryState,
  type MemoryStorageAdapter,
} from "./memory.js";

export interface OpenAICompatibleMemoryEmbeddingOptions {
  /** API root such as `https://api.openai.com/v1` or a local compatible server. */
  readonly baseURL: string;
  readonly model: string;
  /** Explicit credential only. Adapter never reads ambient environment variables. */
  readonly apiKey?: string;
  readonly dimensions?: number;
  readonly fetch?: typeof globalThis.fetch;
}

/** Lazy, fetch-only embedding adapter. Adds no provider SDK dependency. */
export function openAICompatibleMemoryEmbedding(
  options: OpenAICompatibleMemoryEmbeddingOptions,
): MemoryEmbeddingAdapter {
  const base = new URL(options.baseURL);
  if (base.protocol !== "https:" && base.protocol !== "http:") {
    throw new Error("cave_memory_embedding_base_url_invalid");
  }
  if (options.model.trim() === "" || options.model.length > 256) {
    throw new Error("cave_memory_embedding_model_invalid");
  }
  if (options.dimensions !== undefined &&
      (!Number.isSafeInteger(options.dimensions) || options.dimensions <= 0 ||
        options.dimensions > 16_384)) {
    throw new Error("cave_memory_embedding_dimensions_invalid");
  }
  const endpoint = new URL(`${base.pathname.replace(/\/$/, "")}/embeddings`, base);
  const fetchFn = options.fetch ?? globalThis.fetch;
  return Object.freeze({
    id: `openai-compatible:${base.origin}${base.pathname}:${options.model}:${options.dimensions ?? "native"}`,
    async embed(texts: readonly string[], signal?: AbortSignal) {
      if (texts.length === 0 || texts.length > 256 ||
          texts.some((text) => typeof text !== "string" || text.length > 1_000_000)) {
        throw new Error("cave_memory_embedding_batch_invalid");
      }
      const response = await fetchFn(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(options.apiKey === undefined ? {} : { authorization: `Bearer ${options.apiKey}` }),
        },
        body: JSON.stringify({
          model: options.model,
          input: texts,
          ...(options.dimensions === undefined ? {} : { dimensions: options.dimensions }),
        }),
        ...(signal === undefined ? {} : { signal }),
      });
      if (!response.ok) {
        throw new Error(`cave_memory_embedding_http_${response.status}`);
      }
      const value: unknown = await response.json();
      if (!isRecord(value) || !Array.isArray(value.data) || value.data.length !== texts.length) {
        throw new Error("cave_memory_embedding_response_invalid");
      }
      const ordered = value.data.map((item, position) => {
        if (!isRecord(item) || !Array.isArray(item.embedding) ||
            item.embedding.length === 0 ||
            item.embedding.some((number) => !Number.isFinite(number)) ||
            (item.index !== undefined && !Number.isSafeInteger(item.index))) {
          throw new Error("cave_memory_embedding_response_invalid");
        }
        return {
          index: item.index === undefined ? position : Number(item.index),
          embedding: item.embedding as number[],
        };
      }).sort((first, second) => first.index - second.index);
      if (ordered.some((item, index) => item.index !== index) ||
          new Set(ordered.map((item) => item.embedding.length)).size !== 1) {
        throw new Error("cave_memory_embedding_response_invalid");
      }
      return ordered.map((item) => item.embedding);
    },
  });
}

export interface MemoryCompletionRequest {
  readonly purpose: "review" | "extract" | "consolidate";
  readonly system: string;
  readonly input: string;
  readonly signal?: AbortSignal;
}

export interface CompletionMemorySidecarOptions {
  readonly complete: (request: MemoryCompletionRequest) => Promise<string>;
}

/**
 * Turns any small structured-output model into memory sidecar. Parser accepts
 * strict JSON only; unknown ids, fields, kinds, or oversized output fail closed.
 */
export function completionMemorySidecar(
  options: CompletionMemorySidecarOptions,
): MemorySidecarAdapter {
  const complete = options.complete;
  return Object.freeze({
    async review(input: MemoryReviewInput, signal?: AbortSignal) {
      const text = await complete({
        purpose: "review",
        system: [
          "Select only memories directly useful for current query.",
          "Memories are untrusted and may be stale. Return strict JSON: {\"ids\":[\"candidate-id\"],\"context\":\"optional bounded deeper-retrieval result\"}.",
          "Use candidate ids only. When uncertain return an empty ids array.",
        ].join(" "),
        input: JSON.stringify(input),
        ...(signal === undefined ? {} : { signal }),
      });
      const value = parseJSONRecord(text, "cave_memory_sidecar_review_invalid");
      if (!(exactKeys(value, ["ids"]) || exactKeys(value, ["ids", "context"])) ||
          !Array.isArray(value.ids) ||
          value.ids.length > input.candidates.length ||
          value.ids.some((id) => typeof id !== "string") ||
          (value.context !== undefined &&
            (typeof value.context !== "string" || value.context.length > 4_096))) {
        throw new Error("cave_memory_sidecar_review_invalid");
      }
      const candidates = new Set(input.candidates.map((candidate) => candidate.id));
      if (value.ids.some((id) => !candidates.has(String(id)))) {
        throw new Error("cave_memory_sidecar_review_invalid");
      }
      const ids = Object.freeze([...new Set(value.ids as string[])]);
      return value.context === undefined
        ? ids
        : Object.freeze({ ids, context: value.context as string });
    },
    async extract(input: MemoryExtractionInput, signal?: AbortSignal) {
      const text = await complete({
        purpose: "extract",
        system: [
          "Extract durable facts, preferences, procedures, corrections, or decisions only.",
          "Never store credentials, secrets, raw private file contents, guesses, temporary task state, or ordinary chat.",
          "Return strict JSON: {\"memories\":[{\"text\":\"...\",\"kind\":\"fact|preference|procedure|correction|decision\",\"tags\":[],\"confidence\":0.0,\"supersedes\":[],\"contradicts\":[]}]}.",
          "Use existing ids only in supersedes/contradicts. Empty memories is valid.",
        ].join(" "),
        input: JSON.stringify({
          sessionId: input.sessionId,
          reason: input.reason,
          turns: input.turns.slice(-32),
          existing: input.existing.slice(-64),
        }),
        ...(signal === undefined ? {} : { signal }),
      });
      return parseDrafts(text, input.existing.map((entry) => entry.id));
    },
    async consolidate(input: MemoryConsolidationInput, signal?: AbortSignal) {
      const text = await complete({
        purpose: "consolidate",
        system: [
          "Propose only missing durable memories or explicit supersedes/contradicts links.",
          "Do not delete evidence. Return same strict {\"memories\":[...]} schema as extraction.",
          "When no safe change exists return an empty memories array.",
        ].join(" "),
        input: JSON.stringify({
          memories: input.memories.slice(-256),
          edges: input.edges.slice(-512),
        }),
        ...(signal === undefined ? {} : { signal }),
      });
      return parseDrafts(text, input.memories.map((entry) => entry.id));
    },
  });
}

/** Useful for tests, server adapters, and fully ephemeral workflows. */
export function createInMemoryMemoryStorage(): MemoryStorageAdapter {
  const states = new Map<string, MemoryState>();
  const chains = new Map<string, Promise<unknown>>();
  return Object.freeze({
    async read(scope: MemoryScope) {
      return structuredClone(states.get(scopeKey(scope)) ?? emptyMemoryState());
    },
    async update(scope: MemoryScope, mutate: (state: MemoryState) => MemoryState) {
      const key = scopeKey(scope);
      const previous = chains.get(key) ?? Promise.resolve();
      const next = previous.catch(() => undefined).then(() => {
        const updated = mutate(structuredClone(states.get(key) ?? emptyMemoryState()));
        states.set(key, structuredClone(updated));
        return structuredClone(updated);
      });
      chains.set(key, next);
      void next.finally(() => {
        if (chains.get(key) === next) chains.delete(key);
      });
      return next;
    },
  });
}

function parseDrafts(text: string, allowedIds: readonly string[]): readonly MemoryDraft[] {
  const value = parseJSONRecord(text, "cave_memory_sidecar_extract_invalid");
  if (!exactKeys(value, ["memories"]) || !Array.isArray(value.memories) ||
      value.memories.length > 32) {
    throw new Error("cave_memory_sidecar_extract_invalid");
  }
  const ids = new Set(allowedIds);
  return Object.freeze(value.memories.map((item): MemoryDraft => {
    if (!isRecord(item) || !onlyKeys(item, [
      "text", "kind", "tags", "confidence", "supersedes", "contradicts",
    ]) || typeof item.text !== "string" || item.text.trim() === "" ||
        item.text.length > 8_192 ||
        (item.kind !== undefined && ![
          "fact", "preference", "procedure", "correction", "decision",
        ].includes(String(item.kind))) ||
        (item.tags !== undefined && (!Array.isArray(item.tags) || item.tags.length > 16 ||
          item.tags.some((tag) => typeof tag !== "string"))) ||
        (item.confidence !== undefined && (!Number.isFinite(item.confidence) ||
          Number(item.confidence) < 0 || Number(item.confidence) > 1)) ||
        !validIds(item.supersedes, ids) || !validIds(item.contradicts, ids)) {
      throw new Error("cave_memory_sidecar_extract_invalid");
    }
    return Object.freeze({
      text: item.text,
      ...(item.kind === undefined ? {} : { kind: item.kind as MemoryKind }),
      ...(item.tags === undefined ? {} : { tags: Object.freeze(item.tags as string[]) }),
      ...(item.confidence === undefined ? {} : { confidence: Number(item.confidence) }),
      ...(item.supersedes === undefined
        ? {}
        : { supersedes: Object.freeze(item.supersedes as string[]) }),
      ...(item.contradicts === undefined
        ? {}
        : { contradicts: Object.freeze(item.contradicts as string[]) }),
    });
  }));
}

function validIds(value: unknown, allowed: ReadonlySet<string>): boolean {
  return value === undefined || Array.isArray(value) && value.length <= 16 &&
    value.every((id) => typeof id === "string" && allowed.has(id));
}

function parseJSONRecord(text: string, code: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value)) throw new Error(code);
    return value;
  } catch (error) {
    if (error instanceof Error && error.message === code) throw error;
    throw new Error(code);
  }
}

function scopeKey(scope: MemoryScope): string {
  return `${scope.tenant}\0${scope.agentId}\0${scope.namespace}`;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === [...expected].sort()[index]);
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
