/**
 * PEBBLE session entry schema — VERSION 1, FROZEN.
 *
 * Sessions persist as a tree of entries (tree-JSONL): every entry points at
 * its parent via `parentId`, so branching is "append a new entry pointing at
 * an earlier id" — in place, no file fork. Compaction replaces the head of a
 * branch with an entry whose role is "summary" and whose `firstKeptEntryId`
 * pointer is carried by the session.compacting event.
 *
 * The `v` field exists for migrating loaders: readers must never rewrite old
 * lines; they migrate on load.
 */

import { isUsage, type Usage } from "./events.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** RFC 3339 timestamp with mandatory date, seconds, timezone. */
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && RFC3339.test(value);
}

/** Who authored the entry. "summary" marks compaction-written synthetic entries. */
export type SessionRole = "user" | "assistant" | "system" | "summary";

export const SESSION_ROLES = ["user", "assistant", "system", "summary"] as const;

/**
 * One persisted conversation node.
 */
export interface SessionEntry {
  /** Entry id, unique within the session store. */
  id: string;
  /** Parent entry id, or null for the tree root. */
  parentId: string | null;
  role: SessionRole;
  /** Full text content of the entry (deltas already concatenated). */
  content: string;
  /** Token/cost accounting when the entry was produced by model calls. */
  usage?: Usage;
  /** RFC 3339 timestamp of creation. */
  ts: string;
  /** Schema version. Always 1 inside this major line; drives migrating loaders. */
  v: 1;
}

/**
 * Validate one parsed JSONL line against the frozen v1 session-entry schema.
 * Strict about documented fields; tolerant ONLY of unknown extra properties
 * (additive-minor evolution — see README versioning policy).
 */
export function isSessionEntry(value: unknown): value is SessionEntry {
  if (!isRecord(value)) {
    return false;
  }
  const e: Record<string, unknown> = value;
  if (!isNonEmptyString(e["id"])) return false;

  // parentId: exactly null or a non-empty string. undefined fails both.
  const parentId: unknown = e["parentId"];
  if (parentId !== null && !isNonEmptyString(parentId)) return false;

  if (
    typeof e["role"] !== "string" ||
    !(SESSION_ROLES as readonly string[]).includes(e["role"])
  ) {
    return false;
  }

  if (typeof e["content"] !== "string") return false;

  // usage: absent or fully valid when present. An explicit undefined value
  // counts as present-but-invalid only if it isn't undefined-shaped; treat
  // undefined like absence to keep JSON round-trips honest (JSON has no
  // undefined, so this only affects in-memory construction).
  const usage: unknown = e["usage"];
  if (usage !== undefined && !isUsage(usage)) return false;

  if (!isIsoTimestamp(e["ts"])) return false;

  if (e["v"] !== 1) return false;

  return true;
}
