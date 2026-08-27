import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  MemoryEdge,
  MemoryKind,
  MemoryRecord,
  MemoryScope,
  MemoryState,
  MemoryStorageAdapter,
  MemoryTurn,
  MemoryVector,
} from "./memory.js";

/**
 * Durable, tenant-scoped local memory.
 *
 * `memory({ ttl: "30d" })` is a REAL 30-day promise: entries persist across
 * process restarts in a per-namespace JSON file written with an atomic
 * temp-write + rename, not a process-lifetime Map whose ttl was fiction. The
 * store is deliberately dep-free — @caveman-ai/agent keeps a tight dependency
 * surface, so this uses only node:fs rather than pulling in a SQLite driver.
 *
 * A durable, byte-exact-recoverable local store. It records memory state; it
 * does not measure provider usage or savings.
 */
export interface MemoryEntry {
  readonly text: string;
  readonly createdAt: number;
}

/**
 * Where durable memory lives, and for whom. Threaded from
 * `RunOptions.memory` so an embedding server can point at its own location AND
 * scope per tenant, so two tenants sharing an agent id + namespace never see
 * each other's memories.
 */
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

const TENANT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/i;
const AGENT_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/;
const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,95}$/;

function defaultRoot(): string {
  return process.env.CAVE_AGENT_MEMORY_ROOT ?? join(homedir(), ".caveman", "agent-memory");
}

/**
 * The durable file for (tenant, agentId, namespace). The three scoping
 * components are validated to a `[a-z0-9_-]`-class charset with no `.` or path
 * separator, so no component can traverse out of the memory root.
 */
export function memoryFilePath(
  config: MemoryStoreConfig | undefined,
  agentId: string,
  namespace: string,
): string {
  const tenant = config?.tenant ?? "_";
  if (tenant !== "_" && !TENANT_PATTERN.test(tenant)) {
    throw new Error("cave_memory_tenant_invalid");
  }
  if (!AGENT_PATTERN.test(agentId)) throw new Error("cave_memory_agent_invalid");
  if (!NAMESPACE_PATTERN.test(namespace)) throw new Error("cave_memory_namespace_invalid");
  return join(config?.root ?? defaultRoot(), tenant, agentId, `${namespace}.json`);
}

function isMemoryEntry(value: unknown): value is MemoryEntry {
  return value !== null && typeof value === "object" &&
    typeof (value as { text?: unknown }).text === "string" &&
    Number.isSafeInteger((value as { createdAt?: unknown }).createdAt);
}

/** Read the durable entries. A missing or corrupt file is an empty store, never a throw into a run. */
export async function readMemories(filePath: string): Promise<MemoryEntry[]> {
  const state = await readMemoryState(filePath);
  return state.memories.filter((entry) => entry.active)
    .map(({ text, createdAt }) => ({ text, createdAt }));
}

// Per-path serialization so a read-modify-write in one process cannot lose a
// concurrent one. Across processes, the atomic rename still prevents a torn
// file; the weaker guarantee there is last-writer-wins, which is acceptable for
// a per-tenant memory namespace and documented in the README.
const writeChains = new Map<string, Promise<unknown>>();

async function atomicWrite(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  // Memory may contain prompt, customer, or tool-result data. Keep both final
  // file and atomic temporary private, independent of process umask. `wx`
  // also refuses a pre-existing path instead of following it.
  try {
    await writeFile(tmp, JSON.stringify(value), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(tmp, filePath);
  } finally {
    // A failed write/rename must not strand prompt or customer data in a
    // discoverable temp file.
    await rm(tmp, { force: true });
  }
}

/**
 * Serialized read-modify-write of one namespace file. The mutator runs on the
 * current durable entries and its result is persisted atomically; the resolved
 * value is the persisted set. Used for both remember (append) and recall
 * (evict-expired-on-read).
 */
export function mutateMemories(
  filePath: string,
  mutator: (entries: MemoryEntry[]) => MemoryEntry[],
): Promise<MemoryEntry[]> {
  const next = mutateMemoryState(filePath, (state) => {
    const current = state.memories.filter((entry) => entry.active)
      .map(({ text, createdAt }) => ({ text, createdAt }));
    const updated = mutator([...current]);
    const retained = new Map(state.memories.map((entry) => [legacyKey(entry), entry]));
    const memories = updated.map((entry): MemoryRecord => {
      const existing = retained.get(legacyKey(entry));
      if (existing !== undefined) return existing;
      return legacyRecord(entry);
    });
    const ids = new Set(memories.map((entry) => entry.id));
    return {
      schemaVersion: 1,
      revision: state.revision + 1,
      memories,
      turns: state.turns,
      edges: state.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)),
    };
  }).then((state) => state.memories.filter((entry) => entry.active)
    .map(({ text, createdAt }) => ({ text, createdAt })));
  return next;
}

/** Read v1 state, migrating the original entry-array shape in memory. */
export async function readMemoryState(filePath: string): Promise<MemoryState> {
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
    if (Array.isArray(parsed)) {
      return memoryState(parsed.filter(isMemoryEntry).map(legacyRecord), [], [], 0);
    }
    if (!isMemoryState(parsed)) return emptyState();
    return memoryState(parsed.memories, parsed.turns, parsed.edges, parsed.revision);
  } catch {
    return emptyState();
  }
}

/** Serialized atomic state mutation used by the built-in file adapter. */
export function mutateMemoryState(
  filePath: string,
  mutator: (state: MemoryState) => MemoryState,
): Promise<MemoryState> {
  const previous = writeChains.get(filePath) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    const current = await readMemoryState(filePath);
    const updated = mutator(structuredClone(current));
    if (!isMemoryState(updated)) throw new Error("cave_memory_state_invalid");
    await atomicWrite(filePath, updated);
    return memoryState(updated.memories, updated.turns, updated.edges, updated.revision);
  });
  writeChains.set(filePath, next);
  void next.catch(() => undefined).finally(() => {
    if (writeChains.get(filePath) === next) writeChains.delete(filePath);
  });
  return next;
}

/** Default dependency-free adapter. Scope chooses tenant/agent/namespace. */
export function createFileMemoryAdapter(
  config: Pick<MemoryStoreConfig, "root"> = {},
): MemoryStorageAdapter {
  return Object.freeze({
    read(scope: MemoryScope) {
      return readMemoryState(memoryFilePath(
        { ...config, tenant: scope.tenant }, scope.agentId, scope.namespace,
      ));
    },
    update(scope: MemoryScope, mutate: (state: MemoryState) => MemoryState) {
      return mutateMemoryState(memoryFilePath(
        { ...config, tenant: scope.tenant }, scope.agentId, scope.namespace,
      ), mutate);
    },
  });
}

function emptyState(): MemoryState {
  return memoryState([], [], [], 0);
}

function memoryState(
  memories: readonly MemoryRecord[],
  turns: readonly MemoryTurn[],
  edges: readonly MemoryEdge[],
  revision: number,
): MemoryState {
  return Object.freeze({
    schemaVersion: 1,
    revision,
    memories: Object.freeze([...memories]),
    turns: Object.freeze([...turns]),
    edges: Object.freeze([...edges]),
  });
}

function legacyRecord(entry: MemoryEntry): MemoryRecord {
  const id = `legacy-${createHash("sha256")
    .update(`${entry.createdAt}\0${entry.text}`)
    .digest("hex")
    .slice(0, 24)}`;
  return Object.freeze({
    id,
    text: entry.text,
    kind: "fact",
    tags: Object.freeze([]),
    createdAt: entry.createdAt,
    updatedAt: entry.createdAt,
    // Zero means legacy: engine resolves it against declared ttl.
    expiresAt: 0,
    confidence: 0.7,
    strength: 1,
    active: true,
    sources: Object.freeze([]),
  });
}

function legacyKey(entry: Pick<MemoryEntry, "text" | "createdAt">): string {
  return `${entry.createdAt}\0${entry.text}`;
}

function isMemoryState(value: unknown): value is MemoryState {
  if (!isRecord(value) || value.schemaVersion !== 1 ||
      !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 ||
      !Array.isArray(value.memories) || !value.memories.every(isMemoryRecord) ||
      !Array.isArray(value.turns) || !value.turns.every(isMemoryTurn) ||
      !Array.isArray(value.edges) || !value.edges.every(isMemoryEdge)) return false;
  return true;
}

function isMemoryRecord(value: unknown): value is MemoryRecord {
  return isRecord(value) && typeof value.id === "string" && value.id.length > 0 &&
    typeof value.text === "string" && knownKind(value.kind) &&
    Array.isArray(value.tags) && value.tags.every((tag) => typeof tag === "string") &&
    Number.isSafeInteger(value.createdAt) && Number.isSafeInteger(value.updatedAt) &&
    Number.isSafeInteger(value.expiresAt) && Number.isFinite(value.confidence) &&
    Number.isSafeInteger(value.strength) && typeof value.active === "boolean" &&
    Array.isArray(value.sources) && value.sources.every((source) => isRecord(source) &&
      typeof source.sessionId === "string" && Number.isSafeInteger(source.at) &&
      (source.turnId === undefined || typeof source.turnId === "string")) &&
    (value.vector === undefined || isMemoryVector(value.vector));
}

function isMemoryTurn(value: unknown): value is MemoryTurn {
  return isRecord(value) && typeof value.id === "string" &&
    typeof value.sessionId === "string" && Number.isSafeInteger(value.sequence) &&
    (value.role === "user" || value.role === "assistant") &&
    typeof value.text === "string" && Number.isSafeInteger(value.createdAt) &&
    (value.vector === undefined || isMemoryVector(value.vector));
}

function isMemoryEdge(value: unknown): value is MemoryEdge {
  return isRecord(value) && typeof value.from === "string" && typeof value.to === "string" &&
    ["relates_to", "supersedes", "contradicts", "derived_from"].includes(String(value.relation)) &&
    Number.isFinite(value.weight) && Number(value.weight) > 0 && Number(value.weight) <= 1 &&
    Number.isSafeInteger(value.createdAt);
}

function isMemoryVector(value: unknown): value is MemoryVector {
  return isRecord(value) && typeof value.adapter === "string" &&
    Number.isSafeInteger(value.dimensions) && Number(value.dimensions) > 0 &&
    Number.isFinite(value.scale) && Number(value.scale) > 0 && typeof value.data === "string";
}

function knownKind(value: unknown): value is MemoryKind {
  return ["fact", "preference", "procedure", "correction", "decision"].includes(String(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
