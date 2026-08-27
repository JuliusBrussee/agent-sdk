import { createHash } from "node:crypto";
import {
  createFileMemoryAdapter,
  type MemoryStoreConfig,
} from "./memory-store.js";

export type MemoryKind = "fact" | "preference" | "procedure" | "correction" | "decision";
export type MemoryRelation =
  | "relates_to"
  | "supersedes"
  | "contradicts"
  | "derived_from";

export interface MemoryScope {
  readonly tenant: string;
  readonly agentId: string;
  readonly namespace: string;
}

/** Quantized vector. JSON stays small enough for a local, dependency-free adapter. */
export interface MemoryVector {
  readonly adapter: string;
  readonly dimensions: number;
  readonly scale: number;
  readonly data: string;
}

export interface MemorySource {
  readonly sessionId: string;
  readonly turnId?: string;
  readonly at: number;
}

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

export interface MemoryTurn {
  readonly id: string;
  readonly sessionId: string;
  readonly sequence: number;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: number;
  readonly vector?: MemoryVector;
}

export interface MemoryEdge {
  readonly from: string;
  readonly to: string;
  readonly relation: MemoryRelation;
  readonly weight: number;
  readonly createdAt: number;
}

export interface MemoryState {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly memories: readonly MemoryRecord[];
  readonly turns: readonly MemoryTurn[];
  readonly edges: readonly MemoryEdge[];
}

export interface MemoryStorageAdapter {
  read(scope: MemoryScope): Promise<MemoryState>;
  update(
    scope: MemoryScope,
    mutate: (state: MemoryState) => MemoryState,
  ): Promise<MemoryState>;
}

export interface MemoryEmbeddingAdapter {
  /** Stable model/vector-space identity. Different ids are never compared. */
  readonly id: string;
  embed(texts: readonly string[], signal?: AbortSignal): Promise<readonly (readonly number[])[]>;
}

export interface MemoryDraft {
  readonly text: string;
  readonly kind?: MemoryKind;
  readonly tags?: readonly string[];
  readonly confidence?: number;
  readonly supersedes?: readonly string[];
  readonly contradicts?: readonly string[];
}

export interface MemoryReviewInput {
  readonly query: string;
  readonly candidates: readonly MemoryHit[];
}

export interface MemoryReviewResult {
  readonly ids: readonly string[];
  /** Optional bounded result of sidecar-owned deeper retrieval. Still untrusted. */
  readonly context?: string;
}

export interface MemoryExtractionInput {
  readonly sessionId: string;
  readonly turns: readonly MemoryTurn[];
  readonly existing: readonly MemoryRecord[];
  readonly reason: "turns" | "drift" | "session_end";
}

export interface MemoryConsolidationInput {
  readonly memories: readonly MemoryRecord[];
  readonly edges: readonly MemoryEdge[];
}

/** Optional small-model seam. Nothing invokes another model unless supplied. */
export interface MemorySidecarAdapter {
  review?(
    input: MemoryReviewInput,
    signal?: AbortSignal,
  ): Promise<readonly string[] | MemoryReviewResult>;
  extract?(input: MemoryExtractionInput, signal?: AbortSignal): Promise<readonly MemoryDraft[]>;
  consolidate?(
    input: MemoryConsolidationInput,
    signal?: AbortSignal,
  ): Promise<readonly MemoryDraft[]>;
}

export interface MemoryHit {
  readonly id: string;
  readonly text: string;
  readonly kind: MemoryKind;
  readonly tags: readonly string[];
  readonly score: number;
  readonly confidence: number;
  readonly source: "vector" | "lexical" | "graph";
}

export interface MemorySessionHit {
  readonly id: string;
  readonly sessionId: string;
  readonly sequence: number;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly score: number;
  readonly source: "vector" | "lexical";
}

export interface MemoryRecall {
  readonly query: string;
  readonly hits: readonly MemoryHit[];
  readonly prompt: string;
  readonly basis: "inferred";
  readonly sidecarContext?: string;
}

export interface MemoryAmbientOptions {
  /** Assistant turns between extraction passes. Defaults to 8. */
  readonly extractEveryTurns?: number;
  /** Extract old topic when user-vector similarity drops below this. Defaults to 0.35. */
  readonly driftThreshold?: number;
  /** New memories between deep consolidation passes. Defaults to 32. */
  readonly consolidateEveryWrites?: number;
}

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

export interface MemoryTurnInput {
  readonly sessionId: string;
  readonly text: string;
  readonly turnId?: string;
}

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

export interface MemorySearchOptions {
  readonly maxResults?: number;
  readonly minScore?: number;
  readonly graphDepth?: number;
  readonly exclude?: ReadonlySet<string>;
  readonly signal?: AbortSignal;
}

interface SessionRuntime {
  buffer: MemoryTurn[];
  assistantTurns: number;
  sequence: number;
  surfaced: Set<string>;
  previousUserVector?: MemoryVector;
}

const DEFAULT_RECALL_TOKENS = 800;
const DEFAULT_MAX_RESULTS = 6;
const DEFAULT_MIN_SCORE = 0.08;
const DEFAULT_GRAPH_DEPTH = 1;
const DEFAULT_MAX_SESSION_TURNS = 2_000;
const DEFAULT_EXTRACT_EVERY = 8;
const DEFAULT_DRIFT_THRESHOLD = 0.35;
const DEFAULT_CONSOLIDATE_EVERY = 32;
const MAX_MEMORY_TEXT = 8_192;
const MAX_TAGS = 16;
const MAX_SIDE_CAR_DRAFTS = 32;

export class MemoryEngine {
  readonly scope: MemoryScope;
  readonly storage: MemoryStorageAdapter;
  readonly embedding: MemoryEmbeddingAdapter | undefined;
  private readonly sidecar: MemorySidecarAdapter | undefined;
  private readonly ttlMs: number;
  private readonly recallTokens: number;
  private readonly maxResults: number;
  private readonly minScore: number;
  private readonly graphDepth: number;
  private readonly maxSessionTurns: number;
  private readonly ambient: false | Required<MemoryAmbientOptions>;
  private readonly now: () => number;
  private readonly onError: ((error: Error) => void) | undefined;
  private readonly allowStore: ((text: string) => boolean) | undefined;
  private readonly sessions = new Map<string, SessionRuntime>();
  private readonly pending = new Map<string, MemoryRecall>();
  private tail: Promise<void> = Promise.resolve();
  private writesSinceConsolidation = 0;
  private consolidating = false;

  constructor(options: CreateMemoryEngineOptions) {
    validateScope(options.scope);
    if (!Number.isSafeInteger(options.ttlMs) || options.ttlMs <= 0) {
      throw new Error("cave_memory_ttl_invalid");
    }
    this.scope = Object.freeze({ ...options.scope });
    this.storage = options.storage ?? createFileMemoryAdapter();
    this.embedding = options.embedding === false
      ? undefined
      : options.embedding ?? createSparseEmbeddingAdapter();
    this.sidecar = options.sidecar;
    this.ttlMs = options.ttlMs;
    this.recallTokens = nonNegativeInteger(options.recallTokens, DEFAULT_RECALL_TOKENS,
      "cave_memory_recall_budget_invalid");
    this.maxResults = positiveInteger(options.maxResults, DEFAULT_MAX_RESULTS,
      "cave_memory_result_limit_invalid");
    this.minScore = bounded(options.minScore, DEFAULT_MIN_SCORE, 0, 1,
      "cave_memory_score_invalid");
    this.graphDepth = integerRange(options.graphDepth, DEFAULT_GRAPH_DEPTH, 0, 3,
      "cave_memory_graph_depth_invalid");
    this.maxSessionTurns = positiveInteger(options.maxSessionTurns, DEFAULT_MAX_SESSION_TURNS,
      "cave_memory_session_limit_invalid");
    this.ambient = options.ambient === false ? false : {
      extractEveryTurns: positiveInteger(
        options.ambient?.extractEveryTurns, DEFAULT_EXTRACT_EVERY,
        "cave_memory_extract_interval_invalid",
      ),
      driftThreshold: bounded(
        options.ambient?.driftThreshold, DEFAULT_DRIFT_THRESHOLD, 0, 1,
        "cave_memory_drift_threshold_invalid",
      ),
      consolidateEveryWrites: positiveInteger(
        options.ambient?.consolidateEveryWrites, DEFAULT_CONSOLIDATE_EVERY,
        "cave_memory_consolidation_interval_invalid",
      ),
    };
    this.now = options.now ?? Date.now;
    this.onError = options.onError;
    this.allowStore = options.allowStore;
  }

  /**
   * Zero-latency passive seam. Returns completed recall from prior turn, then
   * queues current turn. Slow embeddings or sidecars never delay main agent.
   */
  beginTurn(input: MemoryTurnInput): MemoryRecall | undefined {
    validateTurnInput(input);
    if (!this.canStore(input.text)) {
      this.pending.delete(input.sessionId);
      return undefined;
    }
    const ready = this.pending.get(input.sessionId);
    this.pending.delete(input.sessionId);
    this.enqueue(() => this.processTurn("user", input));
    return ready;
  }

  /** Queues assistant response for session RAG and ambient extraction. */
  endTurn(input: MemoryTurnInput): void {
    validateTurnInput(input);
    if (!this.canStore(input.text)) return;
    this.enqueue(() => this.processTurn("assistant", input));
  }

  /** Waits only when caller deliberately closes/flushes session. */
  async endSession(sessionId: string, signal?: AbortSignal): Promise<void> {
    validateSessionId(sessionId);
    await this.flush();
    const runtime = this.sessions.get(sessionId);
    if (runtime !== undefined && runtime.buffer.length > 0) {
      await this.extract(runtime, sessionId, "session_end", signal);
    }
    await this.flush();
    if (this.ambient !== false) {
      await this.consolidate(signal);
    }
    await this.flush();
    this.sessions.delete(sessionId);
    this.pending.delete(sessionId);
  }

  async flush(): Promise<void> {
    await this.tail;
  }

  async remember(input: MemoryRememberInput, signal?: AbortSignal): Promise<MemoryRecord> {
    const text = normalizeMemoryText(input.text);
    this.assertStoreAllowed(text);
    const now = this.now();
    const vector = await this.embedOne(text, signal);
    const tags = normalizeTags(input.tags ?? []);
    const source = input.sessionId === undefined ? [] : [{
      sessionId: input.sessionId,
      ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
      at: now,
    }];
    let remembered: MemoryRecord | undefined;
    await this.storage.update(this.scope, (raw) => {
      const state = pruneState(raw, now, this.maxSessionTurns, this.ttlMs);
      const exact = state.memories.find((entry) => entry.active &&
        normalizeForMatch(entry.text) === normalizeForMatch(text));
      const semantic = exact ?? bestDuplicate(state.memories, vector, text);
      if (semantic !== undefined) {
        remembered = {
          ...semantic,
          updatedAt: now,
          expiresAt: now + this.ttlMs,
          confidence: Math.min(1, Math.max(semantic.confidence, input.confidence ?? 0.7) + 0.03),
          strength: semantic.strength + 1,
          tags: Object.freeze([...new Set([...semantic.tags, ...tags])].slice(0, MAX_TAGS)),
          sources: Object.freeze([...semantic.sources, ...source].slice(-32)),
        };
        return bump(state, {
          memories: state.memories.map((entry) => entry.id === semantic.id ? remembered! : entry),
        });
      }
      remembered = Object.freeze({
        id: crypto.randomUUID(),
        text,
        kind: input.kind ?? "fact",
        tags,
        createdAt: now,
        updatedAt: now,
        expiresAt: now + this.ttlMs,
        confidence: bounded(input.confidence, 0.7, 0, 1, "cave_memory_confidence_invalid"),
        strength: 1,
        active: true,
        sources: Object.freeze(source),
        ...(vector === undefined ? {} : { vector }),
      });
      const memories = [...state.memories, remembered];
      const edges = [...state.edges];
      for (const target of input.supersedes ?? []) {
        if (memories.some((entry) => entry.id === target)) {
          addEdge(edges, remembered.id, target, "supersedes", 1, now);
        }
      }
      for (const target of input.contradicts ?? []) {
        if (memories.some((entry) => entry.id === target)) {
          addEdge(edges, remembered.id, target, "contradicts", 1, now);
        }
      }
      discoverLinks(remembered, memories, edges, now);
      return bump(state, { memories, edges });
    });
    this.writesSinceConsolidation++;
    if (!this.consolidating && this.ambient !== false &&
        this.writesSinceConsolidation >= this.ambient.consolidateEveryWrites) {
      this.writesSinceConsolidation = 0;
      this.enqueue(() => this.consolidate(signal));
    }
    return remembered!;
  }

  async search(query: string, options: MemorySearchOptions = {}): Promise<readonly MemoryHit[]> {
    const normalized = normalizeQuery(query);
    const vector = await this.embedOne(normalized, options.signal);
    const now = this.now();
    const state = await this.storage.update(this.scope, (raw) =>
      pruneState(raw, now, this.maxSessionTurns, this.ttlMs));
    return rankMemories(state, normalized, vector, {
      maxResults: options.maxResults ?? this.maxResults,
      minScore: options.minScore ?? this.minScore,
      graphDepth: options.graphDepth ?? this.graphDepth,
      ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
    });
  }

  async recall(query: string, options: MemorySearchOptions = {}): Promise<MemoryRecall> {
    let hits = [...await this.search(query, options)];
    let sidecarContext: string | undefined;
    if (this.sidecar?.review !== undefined && hits.length > 0) {
      try {
        const reviewed = await this.sidecar.review({ query, candidates: hits }, options.signal);
        const detailed = Array.isArray(reviewed)
          ? undefined
          : reviewed as MemoryReviewResult;
        const ids = detailed?.ids ?? reviewed as readonly string[];
        if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
          throw new Error("cave_memory_sidecar_review_invalid");
        }
        const rawContext = detailed?.context;
        if (rawContext !== undefined &&
            (typeof rawContext !== "string" || rawContext.length > 4_096)) {
          throw new Error("cave_memory_sidecar_review_invalid");
        }
        sidecarContext = rawContext?.trim() || undefined;
        const accepted = new Set(ids);
        hits = hits.filter((hit) => accepted.has(hit.id));
      } catch (error) {
        this.report(error);
        hits = [];
        sidecarContext = undefined;
      }
    }
    const boundedHits = fitHits(hits, this.recallTokens);
    return Object.freeze({
      query,
      hits: Object.freeze(boundedHits),
      prompt: memoryPrompt(boundedHits, sidecarContext),
      basis: "inferred",
      ...(sidecarContext === undefined ? {} : { sidecarContext }),
    });
  }

  async searchSessions(
    query: string,
    options: Omit<MemorySearchOptions, "graphDepth"> = {},
  ): Promise<readonly MemorySessionHit[]> {
    const normalized = normalizeQuery(query);
    const vector = await this.embedOne(normalized, options.signal);
    const now = this.now();
    const state = await this.storage.update(this.scope, (raw) =>
      pruneState(raw, now, this.maxSessionTurns, this.ttlMs));
    return Object.freeze(rankTurns(state.turns, normalized, vector, {
      maxResults: options.maxResults ?? this.maxResults,
      minScore: options.minScore ?? this.minScore,
    }));
  }

  async forget(id: string): Promise<boolean> {
    let found = false;
    const now = this.now();
    await this.storage.update(this.scope, (state) => bump(state, {
      memories: state.memories.map((entry) => {
        if (entry.id !== id) return entry;
        found = true;
        return { ...entry, active: false, updatedAt: now };
      }),
    }));
    return found;
  }

  async link(from: string, to: string, relation: MemoryRelation, weight = 1): Promise<void> {
    if (!knownRelation(relation) || !Number.isFinite(weight) || weight <= 0 || weight > 1) {
      throw new Error("cave_memory_edge_invalid");
    }
    const now = this.now();
    await this.storage.update(this.scope, (state) => {
      if (!state.memories.some((entry) => entry.id === from) ||
          !state.memories.some((entry) => entry.id === to)) {
        throw new Error("cave_memory_edge_target_missing");
      }
      const edges = [...state.edges];
      addEdge(edges, from, to, relation, weight, now);
      return bump(state, { edges });
    });
  }

  async consolidate(signal?: AbortSignal): Promise<void> {
    if (this.consolidating) return;
    this.consolidating = true;
    try {
      const now = this.now();
      let drafts: readonly MemoryDraft[] = [];
      const current = pruneState(
        await this.storage.read(this.scope), now, this.maxSessionTurns, this.ttlMs,
      );
      if (this.sidecar?.consolidate !== undefined) {
        try {
          drafts = (await this.sidecar.consolidate({
            memories: current.memories.filter((entry) => entry.active),
            edges: current.edges,
          }, signal)).slice(0, MAX_SIDE_CAR_DRAFTS);
        } catch (error) {
          this.report(error);
        }
      }
      for (const draft of drafts) {
        await this.remember(draft, signal);
      }
      await this.storage.update(this.scope, (raw) => {
        const state = pruneState(raw, now, this.maxSessionTurns, this.ttlMs);
        const memories = [...state.memories];
        const edges = [...state.edges];
        for (let index = 0; index < memories.length; index++) {
          const currentEntry = memories[index]!;
          if (!currentEntry.active) continue;
          for (let other = index + 1; other < memories.length; other++) {
            const candidate = memories[other]!;
            if (!candidate.active || !duplicates(currentEntry, candidate)) continue;
            const keep = currentEntry.createdAt <= candidate.createdAt ? currentEntry : candidate;
            const retire = keep.id === currentEntry.id ? candidate : currentEntry;
            const keepIndex = memories.findIndex((entry) => entry.id === keep.id);
            const retireIndex = memories.findIndex((entry) => entry.id === retire.id);
            memories[keepIndex] = {
              ...keep,
              updatedAt: now,
              strength: keep.strength + retire.strength,
              confidence: Math.max(keep.confidence, retire.confidence),
              tags: Object.freeze([...new Set([...keep.tags, ...retire.tags])].slice(0, MAX_TAGS)),
              sources: Object.freeze([...keep.sources, ...retire.sources].slice(-32)),
            };
            memories[retireIndex] = { ...retire, active: false, updatedAt: now };
            addEdge(edges, keep.id, retire.id, "supersedes", 1, now);
          }
        }
        return bump(state, { memories, edges });
      });
    } finally {
      this.consolidating = false;
    }
  }

  private enqueue(work: () => Promise<void>): void {
    this.tail = this.tail.then(work).catch((error) => this.report(error));
  }

  private async processTurn(role: MemoryTurn["role"], input: MemoryTurnInput): Promise<void> {
    const now = this.now();
    let vector: MemoryVector | undefined;
    try {
      vector = await this.embedOne(input.text);
    } catch (error) {
      this.report(error);
    }
    const runtime = this.sessions.get(input.sessionId) ?? {
      buffer: [], assistantTurns: 0, sequence: 0, surfaced: new Set<string>(),
    };
    this.sessions.set(input.sessionId, runtime);
    if (role === "user" && this.ambient !== false && vector !== undefined &&
        runtime.previousUserVector !== undefined && runtime.buffer.length > 0 &&
        sameVectorSpace(vector, runtime.previousUserVector) &&
        cosine(vector, runtime.previousUserVector) < this.ambient.driftThreshold) {
      await this.extract(runtime, input.sessionId, "drift");
      runtime.surfaced.clear();
    }
    runtime.sequence++;
    const turn: MemoryTurn = Object.freeze({
      id: input.turnId ?? crypto.randomUUID(),
      sessionId: input.sessionId,
      sequence: runtime.sequence,
      role,
      text: input.text,
      createdAt: now,
      ...(vector === undefined ? {} : { vector }),
    });
    runtime.buffer.push(turn);
    if (role === "user" && vector !== undefined) runtime.previousUserVector = vector;
    await this.storage.update(this.scope, (raw) => {
      const state = pruneState(raw, now, this.maxSessionTurns, this.ttlMs);
      return bump(state, { turns: [...state.turns, turn].slice(-this.maxSessionTurns) });
    });
    if (role === "user") {
      const recall = await this.recall(input.text, { exclude: runtime.surfaced });
      if (recall.hits.length > 0) {
        for (const hit of recall.hits) runtime.surfaced.add(hit.id);
        this.pending.set(input.sessionId, recall);
        await this.reinforceRecall(recall.hits);
      }
      return;
    }
    runtime.assistantTurns++;
    if (this.ambient !== false &&
        runtime.assistantTurns >= this.ambient.extractEveryTurns) {
      await this.extract(runtime, input.sessionId, "turns");
    }
  }

  private async extract(
    runtime: SessionRuntime,
    sessionId: string,
    reason: MemoryExtractionInput["reason"],
    signal?: AbortSignal,
  ): Promise<void> {
    const turns = runtime.buffer.splice(0);
    runtime.assistantTurns = 0;
    if (turns.length === 0 || this.sidecar?.extract === undefined) return;
    try {
      const state = await this.storage.read(this.scope);
      const drafts = (await this.sidecar.extract({
        sessionId,
        turns,
        existing: state.memories.filter((entry) => entry.active).slice(-64),
        reason,
      }, signal)).slice(0, MAX_SIDE_CAR_DRAFTS);
      for (const draft of drafts) {
        await this.remember({ ...draft, sessionId }, signal);
      }
    } catch (error) {
      runtime.buffer.unshift(...turns);
      runtime.buffer = runtime.buffer.slice(-64);
      this.report(error);
    }
  }

  private async reinforceRecall(hits: readonly MemoryHit[]): Promise<void> {
    const ids = new Set(hits.map((hit) => hit.id));
    const now = this.now();
    await this.storage.update(this.scope, (state) => {
      const memories = state.memories.map((entry) => ids.has(entry.id)
        ? { ...entry, updatedAt: now, confidence: Math.min(1, entry.confidence + 0.01) }
        : entry);
      const edges = [...state.edges];
      const hitIds = [...ids];
      for (let index = 0; index < hitIds.length; index++) {
        for (let other = index + 1; other < hitIds.length; other++) {
          addEdge(edges, hitIds[index]!, hitIds[other]!, "relates_to", 0.5, now);
        }
      }
      return bump(state, { memories, edges });
    });
  }

  private async embedOne(text: string, signal?: AbortSignal): Promise<MemoryVector | undefined> {
    if (this.embedding === undefined) return undefined;
    const vectors = await this.embedding.embed([text], signal);
    if (vectors.length !== 1) throw new Error("cave_memory_embedding_count_mismatch");
    return packVector(this.embedding.id, vectors[0]!);
  }

  private assertStoreAllowed(text: string): void {
    if (!this.canStore(text)) {
      throw new Error("cave_memory_sensitive_value_refused");
    }
  }

  private canStore(text: string): boolean {
    return !looksSensitive(text) && this.allowStore?.(text) !== false;
  }

  private report(error: unknown): void {
    try {
      this.onError?.(error instanceof Error ? error : new Error(String(error)));
    } catch {
      // Error reporting is observational; it cannot break memory queue settlement.
    }
  }
}

export function createMemoryEngine(options: CreateMemoryEngineOptions): MemoryEngine {
  return new MemoryEngine(options);
}

/** Minimal adapter for any agent workflow, independent of provider/framework. */
export function createMemoryWorkflow(engine: MemoryEngine, sessionId: string) {
  validateSessionId(sessionId);
  return Object.freeze({
    beforeTurn(text: string): string | undefined {
      return engine.beginTurn({ sessionId, text })?.prompt || undefined;
    },
    afterTurn(text: string): void {
      engine.endTurn({ sessionId, text });
    },
    search(query: string, options?: MemorySearchOptions) {
      return engine.search(query, options);
    },
    remember(input: string | MemoryRememberInput, signal?: AbortSignal) {
      return engine.remember(typeof input === "string" ? { text: input } : input, signal);
    },
    searchSessions(query: string, options?: Omit<MemorySearchOptions, "graphDepth">) {
      return engine.searchSessions(query, options);
    },
    close(signal?: AbortSignal) {
      return engine.endSession(sessionId, signal);
    },
  });
}

/** Dependency-free fallback. Sparse lexical vector, not claimed as semantic. */
export function createSparseEmbeddingAdapter(dimensions = 256): MemoryEmbeddingAdapter {
  if (!Number.isSafeInteger(dimensions) || dimensions < 64 || dimensions > 4_096) {
    throw new Error("cave_memory_sparse_dimensions_invalid");
  }
  return Object.freeze({
    id: `caveman.sparse-hash.v1:${dimensions}`,
    async embed(texts: readonly string[]) {
      return texts.map((text) => sparseVector(text, dimensions));
    },
  });
}

export function packVector(adapter: string, input: readonly number[]): MemoryVector {
  if (adapter.trim() === "" || input.length === 0 || input.length > 16_384 ||
      input.some((value) => !Number.isFinite(value))) {
    throw new Error("cave_memory_embedding_invalid");
  }
  const norm = Math.sqrt(input.reduce((sum, value) => sum + value * value, 0));
  if (!(norm > 0)) throw new Error("cave_memory_embedding_zero_vector");
  const normalized = input.map((value) => value / norm);
  const max = Math.max(...normalized.map(Math.abs));
  const scale = max / 127;
  const bytes = new Int8Array(normalized.length);
  for (let index = 0; index < normalized.length; index++) {
    bytes[index] = Math.max(-127, Math.min(127, Math.round(normalized[index]! / scale)));
  }
  return Object.freeze({
    adapter,
    dimensions: bytes.length,
    scale,
    data: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64"),
  });
}

export function cosine(first: MemoryVector, second: MemoryVector): number {
  if (!sameVectorSpace(first, second)) return 0;
  const left = decodeVector(first);
  const right = decodeVector(second);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index++) {
    const l = left[index]! * first.scale;
    const r = right[index]! * second.scale;
    dot += l * r;
    leftNorm += l * l;
    rightNorm += r * r;
  }
  return leftNorm === 0 || rightNorm === 0 ? 0 : dot / Math.sqrt(leftNorm * rightNorm);
}

export function emptyMemoryState(): MemoryState {
  return Object.freeze({
    schemaVersion: 1,
    revision: 0,
    memories: Object.freeze([]),
    turns: Object.freeze([]),
    edges: Object.freeze([]),
  });
}

function rankMemories(
  state: MemoryState,
  query: string,
  vector: MemoryVector | undefined,
  options: Required<Pick<MemorySearchOptions, "maxResults" | "minScore" | "graphDepth">> &
    Pick<MemorySearchOptions, "exclude">,
): MemoryHit[] {
  const active = state.memories.filter((entry) => entry.active);
  const byId = new Map(active.map((entry) => [entry.id, entry]));
  const ranked = new Map<string, MemoryHit>();
  for (const entry of active) {
    if (options.exclude?.has(entry.id)) continue;
    const lexical = lexicalScore(query, entry.text);
    const semantic = vector !== undefined && entry.vector !== undefined &&
      sameVectorSpace(vector, entry.vector)
      ? Math.max(0, cosine(vector, entry.vector))
      : 0;
    const score = semantic > 0 ? 0.85 * semantic + 0.15 * lexical : lexical;
    if (score < options.minScore) continue;
    ranked.set(entry.id, hit(entry, score, semantic > 0 ? "vector" : "lexical"));
  }
  let frontier = [...ranked.values()].sort(byScore).slice(0, options.maxResults * 2);
  const visited = new Set(frontier.map((item) => item.id));
  for (let depth = 0; depth < options.graphDepth && frontier.length > 0; depth++) {
    const next: MemoryHit[] = [];
    for (const seed of frontier) {
      for (const edge of state.edges) {
        const id = edge.from === seed.id ? edge.to : edge.to === seed.id ? edge.from : undefined;
        if (id === undefined || visited.has(id) || options.exclude?.has(id)) continue;
        const entry = byId.get(id);
        if (entry === undefined) continue;
        visited.add(id);
        const score = seed.score * edge.weight * Math.pow(0.75, depth + 1);
        if (score < options.minScore) continue;
        const candidate = hit(entry, score, "graph");
        ranked.set(id, candidate);
        next.push(candidate);
      }
    }
    frontier = next;
  }
  return [...ranked.values()].sort(byScore).slice(0, options.maxResults);
}

function rankTurns(
  turns: readonly MemoryTurn[],
  query: string,
  vector: MemoryVector | undefined,
  options: { maxResults: number; minScore: number },
): MemorySessionHit[] {
  return turns.map((turn): MemorySessionHit | undefined => {
    const lexical = lexicalScore(query, turn.text);
    const semantic = vector !== undefined && turn.vector !== undefined &&
      sameVectorSpace(vector, turn.vector)
      ? Math.max(0, cosine(vector, turn.vector))
      : 0;
    const score = semantic > 0 ? 0.9 * semantic + 0.1 * lexical : lexical;
    if (score < options.minScore) return undefined;
    return Object.freeze({
      id: turn.id,
      sessionId: turn.sessionId,
      sequence: turn.sequence,
      role: turn.role,
      text: turn.text,
      score,
      source: semantic > 0 ? "vector" : "lexical",
    });
  }).filter((item): item is MemorySessionHit => item !== undefined)
    .sort((first, second) => second.score - first.score || second.sequence - first.sequence)
    .slice(0, options.maxResults);
}

function memoryPrompt(hits: readonly MemoryHit[], sidecarContext?: string): string {
  if (hits.length === 0 && sidecarContext === undefined) return "";
  const rows = hits.map((item) =>
    `- [${item.kind}; id=${item.id}; confidence=${item.confidence.toFixed(2)}] ${item.text}`);
  return [
    "<cave-memory-recall basis=\"inferred\">",
    "Prior local memories may be stale or wrong. Use only when relevant; verify current code, tools, and user intent.",
    ...rows,
    ...(sidecarContext === undefined
      ? []
      : ["<sidecar-context>", sidecarContext, "</sidecar-context>"]),
    "</cave-memory-recall>",
  ].join("\n");
}

function fitHits(hits: readonly MemoryHit[], tokenBudget: number): MemoryHit[] {
  const selected: MemoryHit[] = [];
  let used = 0;
  for (const hit of hits) {
    const estimated = Math.ceil((hit.text.length + 96) / 4);
    if (used + estimated > tokenBudget) continue;
    selected.push(hit);
    used += estimated;
  }
  return selected;
}

function pruneState(
  state: MemoryState,
  now: number,
  maxTurns: number,
  ttlMs: number,
): MemoryState {
  const memories = state.memories.map((entry) => {
    const expiresAt = entry.expiresAt === 0 ? entry.createdAt + ttlMs : entry.expiresAt;
    return entry.active && expiresAt < now
      ? { ...entry, expiresAt, active: false, updatedAt: now }
      : entry.expiresAt === expiresAt ? entry : { ...entry, expiresAt };
  });
  const activeIds = new Set(memories.map((entry) => entry.id));
  return {
    ...state,
    memories,
    turns: state.turns.slice(-maxTurns),
    edges: state.edges.filter((edge) => activeIds.has(edge.from) && activeIds.has(edge.to)),
  };
}

function bump(
  state: MemoryState,
  patch: Partial<Pick<MemoryState, "memories" | "turns" | "edges">>,
): MemoryState {
  return {
    schemaVersion: 1,
    revision: state.revision + 1,
    memories: Object.freeze([...(patch.memories ?? state.memories)]),
    turns: Object.freeze([...(patch.turns ?? state.turns)]),
    edges: Object.freeze([...(patch.edges ?? state.edges)]),
  };
}

function bestDuplicate(
  memories: readonly MemoryRecord[],
  vector: MemoryVector | undefined,
  text: string,
): MemoryRecord | undefined {
  let best: { entry: MemoryRecord; score: number } | undefined;
  for (const entry of memories) {
    if (!entry.active) continue;
    const score = vector !== undefined && entry.vector !== undefined &&
      sameVectorSpace(vector, entry.vector)
      ? cosine(vector, entry.vector)
      : lexicalScore(text, entry.text);
    if (score >= 0.965 && (best === undefined || score > best.score)) best = { entry, score };
  }
  return best?.entry;
}

function duplicates(first: MemoryRecord, second: MemoryRecord): boolean {
  if (normalizeForMatch(first.text) === normalizeForMatch(second.text)) return true;
  return first.vector !== undefined && second.vector !== undefined &&
    sameVectorSpace(first.vector, second.vector) && cosine(first.vector, second.vector) >= 0.98;
}

function discoverLinks(
  created: MemoryRecord,
  memories: readonly MemoryRecord[],
  edges: MemoryEdge[],
  now: number,
): void {
  if (created.vector === undefined) return;
  const related = memories.filter((entry) => entry.id !== created.id && entry.active &&
      entry.vector !== undefined && sameVectorSpace(created.vector!, entry.vector))
    .map((entry) => ({ entry, score: cosine(created.vector!, entry.vector!) }))
    .filter((item) => item.score >= 0.72)
    .sort((first, second) => second.score - first.score)
    .slice(0, 4);
  for (const item of related) {
    addEdge(edges, created.id, item.entry.id, "relates_to", item.score, now);
  }
}

function addEdge(
  edges: MemoryEdge[],
  from: string,
  to: string,
  relation: MemoryRelation,
  weight: number,
  createdAt: number,
): void {
  if (from === to || edges.some((edge) => edge.from === from && edge.to === to &&
      edge.relation === relation)) return;
  edges.push(Object.freeze({ from, to, relation, weight, createdAt }));
}

function hit(entry: MemoryRecord, score: number, source: MemoryHit["source"]): MemoryHit {
  return Object.freeze({
    id: entry.id,
    text: entry.text,
    kind: entry.kind,
    tags: entry.tags,
    score: score * (0.5 + 0.5 * entry.confidence),
    confidence: entry.confidence,
    source,
  });
}

function byScore(first: MemoryHit, second: MemoryHit): number {
  return second.score - first.score || first.id.localeCompare(second.id);
}

function sparseVector(text: string, dimensions: number): number[] {
  const values = new Array<number>(dimensions).fill(0);
  const tokens = tokenize(text);
  const features = [
    ...tokens.map((token) => [`t:${token}`, 1] as const),
    ...tokens.slice(0, -1).map((token, index) =>
      [`b:${token}:${tokens[index + 1]}`, 0.6] as const),
  ];
  for (const [feature, weight] of features) {
    const digest = createHash("sha256").update(feature).digest();
    const index = digest.readUInt32BE(0) % dimensions;
    values[index] = values[index]! + ((digest[4]! & 1) === 0 ? weight : -weight);
  }
  if (features.length === 0) values[0] = 1;
  return values;
}

function lexicalScore(query: string, text: string): number {
  const wanted = new Set(tokenize(query));
  const observed = new Set(tokenize(text));
  if (wanted.size === 0 || observed.size === 0) return 0;
  let overlap = 0;
  for (const term of wanted) if (observed.has(term)) overlap++;
  return overlap / Math.sqrt(wanted.size * observed.size);
}

function tokenize(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9][a-z0-9_-]{1,}/g) ?? [];
}

function decodeVector(vector: MemoryVector): Int8Array {
  const bytes = Buffer.from(vector.data, "base64");
  if (bytes.byteLength !== vector.dimensions) throw new Error("cave_memory_vector_corrupt");
  return new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function sameVectorSpace(first: MemoryVector, second: MemoryVector): boolean {
  return first.adapter === second.adapter && first.dimensions === second.dimensions;
}

function normalizeMemoryText(value: string): string {
  const text = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (text.length === 0 || text.length > MAX_MEMORY_TEXT) {
    throw new Error("cave_memory_value_invalid");
  }
  return text;
}

function normalizeQuery(value: string): string {
  const query = typeof value === "string" ? value.trim() : "";
  if (query.length === 0 || query.length > MAX_MEMORY_TEXT) {
    throw new Error("cave_memory_query_invalid");
  }
  return query;
}

function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizeTags(values: readonly string[]): readonly string[] {
  if (values.length > MAX_TAGS) throw new Error("cave_memory_tags_invalid");
  const tags = values.map((value) => value.trim().toLowerCase());
  if (tags.some((value) => !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value))) {
    throw new Error("cave_memory_tags_invalid");
  }
  return Object.freeze([...new Set(tags)]);
}

function looksSensitive(value: string): boolean {
  return /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i.test(value) ||
    /\b(?:sk|gh[pousr])_[A-Za-z0-9_-]{20,}\b/.test(value) ||
    /\bAKIA[A-Z0-9]{16}\b/.test(value) ||
    /\b(?:password|passwd|api[_ -]?key|access[_ -]?token|secret)\s*[:=]\s*\S{8,}/i.test(value);
}

function validateScope(scope: MemoryScope): void {
  if (scope.tenant !== "_" && !/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(scope.tenant)) {
    throw new Error("cave_memory_tenant_invalid");
  }
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/.test(scope.agentId)) {
    throw new Error("cave_memory_agent_invalid");
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,95}$/.test(scope.namespace)) {
    throw new Error("cave_memory_namespace_invalid");
  }
}

function validateSessionId(value: string): void {
  if (typeof value !== "string" || value.trim() === "" || value.length > 256) {
    throw new Error("cave_memory_session_invalid");
  }
}

function validateTurnInput(input: MemoryTurnInput): void {
  validateSessionId(input.sessionId);
  if (typeof input.text !== "string" || input.text.trim() === "" || input.text.length > 1_000_000) {
    throw new Error("cave_memory_turn_invalid");
  }
}

function positiveInteger(value: number | undefined, fallback: number, code: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) throw new Error(code);
  return resolved;
}

function nonNegativeInteger(value: number | undefined, fallback: number, code: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0) throw new Error(code);
  return resolved;
}

function integerRange(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
  code: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < min || resolved > max) throw new Error(code);
  return resolved;
}

function bounded(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
  code: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < min || resolved > max) throw new Error(code);
  return resolved;
}

function knownRelation(value: string): value is MemoryRelation {
  return ["relates_to", "supersedes", "contradicts", "derived_from"].includes(value);
}
