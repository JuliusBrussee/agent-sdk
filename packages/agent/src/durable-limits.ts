/**
 * The few things the journal and its stores must agree on byte-for-byte: the
 * run-id shape, the size ceilings, and two predicates. Its own module so the
 * stores can import them without a cycle back through `durable.ts`.
 */

export const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const MAX_JOURNAL_BYTES = 256 * 1024 * 1024;

const ENCODER = new TextEncoder();

export function utf8Bytes(value: string): number {
  return ENCODER.encode(value).byteLength;
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

/** Filename-safe caller-assigned idempotency key. */
export function validateDurableRunId(runId: string): void {

  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) {
    throw new Error(
      "cave_durable_run_id_invalid: durable.runId must match [A-Za-z0-9][A-Za-z0-9._-]{0,127}",
    );
  }
}
