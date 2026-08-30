/**
 * Out-of-band control over a durable run: cancellation.
 *
 * The journal is already the run's single source of truth across processes and
 * machines, so a control signal belongs in it rather than in a side channel.
 * Appending `cancel_requested` is the whole mechanism: any process can write it,
 * and whichever process is driving the run reads it and stops.
 *
 * This is Temporal's *cancel*, not its *terminate*. The request is cooperative:
 * the driver observes it at a safe boundary, settles what is in flight, and
 * journals its own terminal event, so spend stays accounted and the run's
 * outcome is still a fact the journal records. The forceful variant already
 * exists and needs no API — killing the process is a crash, and crashes are
 * what the journal was built for.
 *
 * Two properties fall out of putting it in the journal, and both matter:
 *
 * - **It survives everything.** A cancellation requested while no instance is
 *   running the job is not lost; the next recovery sweep honours it instead of
 *   re-driving the run, so a cancelled run never spends again.
 * - **It is idempotent.** A second request on a run that already carries one
 *   changes nothing, so a retried `DELETE` costs a journal read and no more.
 */

import {
  DURABLE_JOURNAL_VERSION,
  durableRunSummary,
  type DurableStore,
} from "./durable.js";
import { validateDurableRunId } from "./durable-limits.js";

/**
 * Terminal failure code a cancelled run settles with. It is a `run_failed`
 * rather than a fourth terminal event type: consumers already branch on the
 * code, and a new terminal shape would silently mean "still pending" to every
 * reader that has not been taught about it.
 */
export const DURABLE_CANCELLED_CODE = "cave_durable_run_cancelled";

const MAX_REASON_BYTES = 4096;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

export type DurableCancelOutcome =
  | { readonly status: "requested"; readonly reason: string }
  | { readonly status: "already_requested"; readonly reason: string }
  | { readonly status: "already_settled"; readonly terminal: "completed" | "failed" }
  | { readonly status: "missing" };

/**
 * Ask for `runId` to stop. Returns what was true, so a caller can answer a
 * DELETE honestly instead of pretending every request cancelled something.
 *
 * A settled run is never marked cancelled: its outcome is already a fact, and
 * rewriting history to say otherwise would make the journal lie about money it
 * already spent.
 */
export async function requestDurableCancel(
  store: DurableStore,
  runId: string,
  reason = "cancelled by request",
): Promise<DurableCancelOutcome> {
  validateDurableRunId(runId);
  if (typeof reason !== "string" || reason.length === 0 ||
      new TextEncoder().encode(reason).byteLength > MAX_REASON_BYTES ||
      CONTROL_CHARACTERS.test(reason)) {
    throw new Error("cave_durable_cancel_reason_invalid");
  }
  const summary = durableRunSummary(await store.load(runId));
  if (summary.status === "missing") return { status: "missing" };
  if (summary.status === "completed") {
    return { status: "already_settled", terminal: "completed" };
  }
  if (summary.status === "failed") {
    return { status: "already_settled", terminal: "failed" };
  }
  if (summary.cancelRequested !== undefined) {
    return { status: "already_requested", reason: summary.cancelRequested.reason };
  }
  // Deliberately NOT under the run lock. The lock belongs to whichever process
  // is driving the run; requiring it would mean a run can only be cancelled by
  // the instance that is busy running it, which is exactly the case where
  // cancellation matters most.
  await store.append(runId, `${JSON.stringify({
    v: DURABLE_JOURNAL_VERSION,
    at: new Date().toISOString(),
    type: "cancel_requested",
    reason,
  })}\n`);
  return { status: "requested", reason };
}

/** The outstanding cancellation request on a run, if it has one. */
export async function durableCancelRequest(
  store: DurableStore,
  runId: string,
): Promise<{ readonly reason: string; readonly at: string } | undefined> {
  const summary = durableRunSummary(await store.load(runId));
  return summary.status === "pending" ? summary.cancelRequested : undefined;
}

/**
 * Settle a cancelled run that nobody is driving. Called by a recovery sweep
 * when it finds a pending journal carrying a cancellation request: the run is
 * closed out where it stopped, with no provider call and no spend, instead of
 * being resumed only to be cancelled again.
 */
export async function settleCancelledRun(
  store: DurableStore,
  runId: string,
  request: { readonly reason: string },
): Promise<void> {
  const release = await store.acquire(runId);
  try {
    // Re-read under the lock: between the sweep's scan and this point another
    // instance may have driven the run to a real terminal outcome, and that
    // outcome wins.
    const summary = durableRunSummary(await store.load(runId));
    if (summary.status !== "pending") return;
    await store.append(runId, `${JSON.stringify({
      v: DURABLE_JOURNAL_VERSION,
      at: new Date().toISOString(),
      type: "run_failed",
      code: DURABLE_CANCELLED_CODE,
      message: request.reason,
      receipt: null,
    })}\n`);
  } finally {
    await release();
  }
}

// ---------------------------------------------------------------------------
// Durable sleep
// ---------------------------------------------------------------------------

/**
 * The longest a run may sleep. Not a technical limit — a blast radius. A typo
 * that schedules a wake in the year 3000 should fail at the call site, not
 * become a journal that a recovery sweep politely skips forever.
 */
export const MAX_DURABLE_SLEEP_MS = 30 * 24 * 60 * 60 * 1000;

export type DurableSleepOutcome =
  | { readonly status: "scheduled"; readonly wakeAt: string }
  | { readonly status: "already_settled"; readonly terminal: "completed" | "failed" }
  | { readonly status: "cancelled" }
  | { readonly status: "missing" };

/**
 * Park `runId` until `wakeAt`. The run stays pending and is not eligible to be
 * driven before then.
 *
 * This is the cost primitive. A blocked process is billed for wall-clock in
 * which nothing happens; a journaled wake time is billed for nothing at all,
 * and the platform is free to evict the instance and bring one back when the
 * run is due. Waiting a week costs the same as waiting a second.
 *
 * A cancellation outranks a sleep: parking a run somebody already asked to stop
 * would turn a cancelled run into one that wakes up later to be cancelled.
 */
export async function scheduleDurableWake(
  store: DurableStore,
  runId: string,
  wakeAt: Date,
  reason = "durable sleep",
): Promise<DurableSleepOutcome> {
  validateDurableRunId(runId);
  if (typeof reason !== "string" || reason.length === 0 ||
      new TextEncoder().encode(reason).byteLength > MAX_REASON_BYTES ||
      CONTROL_CHARACTERS.test(reason)) {
    throw new Error("cave_durable_sleep_reason_invalid");
  }
  const at = wakeAt instanceof Date ? wakeAt.getTime() : Number.NaN;
  if (!Number.isFinite(at) || at - Date.now() > MAX_DURABLE_SLEEP_MS) {
    throw new Error("cave_durable_sleep_wake_invalid");
  }
  const summary = durableRunSummary(await store.load(runId));
  if (summary.status === "missing") return { status: "missing" };
  if (summary.status === "completed" || summary.status === "failed") {
    return { status: "already_settled", terminal: summary.status };
  }
  if (summary.cancelRequested !== undefined) return { status: "cancelled" };
  const iso = new Date(at).toISOString();
  await store.append(runId, `${JSON.stringify({
    v: DURABLE_JOURNAL_VERSION,
    at: new Date().toISOString(),
    type: "sleep_scheduled",
    wakeAt: iso,
    reason,
  })}\n`);
  return { status: "scheduled", wakeAt: iso };
}

/**
 * Is this run eligible to be driven right now? The one predicate a recovery
 * sweep needs, so "not due yet" is never confused with "stranded".
 */
export function durableRunIsDue(
  summary: { readonly status: string; readonly wakeAt?: string },
  now: number = Date.now(),
): boolean {
  if (summary.status !== "pending") return false;
  if (summary.wakeAt === undefined) return true;
  const wakeAt = Date.parse(summary.wakeAt);
  // An unparseable wake time is not a licence to run: fail closed and let the
  // journal validator surface it.
  return Number.isFinite(wakeAt) && wakeAt <= now;
}

/**
 * Earliest time any run in `store` becomes due, or undefined when none is
 * sleeping. This is what lets a host scale to zero honestly: set one timer for
 * this instant, shut the instance down, and bring it back exactly when there is
 * work — instead of keeping a process alive to watch a clock.
 *
 * An OVERDUE sleeper is reported too: a wake time in the past means "there is
 * work right now", not "nothing to wake for". A store that cannot enumerate
 * returns undefined, which a caller must likewise read as "unknown", never as
 * "nothing pending".
 */
export async function nextDurableWake(
  store: DurableStore,
): Promise<Date | undefined> {
  if (store.list === undefined) return undefined;
  let earliest: number | undefined;
  for (const runId of await store.list()) {
    let summary;
    try {
      summary = durableRunSummary(await store.load(runId));
    } catch {
      continue; // a corrupt journal is not something to wake for
    }
    if (summary.status !== "pending" || summary.wakeAt === undefined) continue;
    if (summary.cancelRequested !== undefined) continue;
    const wakeAt = Date.parse(summary.wakeAt);
    if (!Number.isFinite(wakeAt)) continue;
    if (earliest === undefined || wakeAt < earliest) earliest = wakeAt;
  }
  return earliest === undefined ? undefined : new Date(earliest);
}
