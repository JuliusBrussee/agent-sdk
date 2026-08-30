/**
 * PEBBLE → ACP (Agent Client Protocol) mapping — VERSION 1, FROZEN.
 *
 * Pebble speaks ACP over stdio (`pebble acp`) by translating its native turn
 * events into ACP methods/notifications. This table IS the translation
 * contract; it is mirrored verbatim in README.md. Rows whose acpMethod is
 * null have no first-class ACP surface — they are TUI-native and either stay
 * internal or ride `_meta` extensions; the notes column says which.
 *
 * Reference: https://agentclientprotocol.com — session/update notification
 * variants and StopReason as of protocol v1.
 */

import type { StopReason, ToolOutcome, TurnEventKind } from "./events.ts";

// ---------------------------------------------------------------------------
// ACP vocabulary constants (what the other side speaks)
// ---------------------------------------------------------------------------

/** StopReason values an ACP agent may return from session/prompt. */
export const ACP_STOP_REASONS = [
  "end_turn",
  "max_tokens",
  "max_turn_requests",
  "refusal",
  "cancelled",
] as const;

export type AcpStopReason = (typeof ACP_STOP_REASONS)[number];

/** session/update variant discriminators referenced by the mapping table. */
export const ACP_UPDATE_VARIANTS = [
  "user_message_chunk",
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
  "available_commands_update",
  "current_mode_update",
  "usage_update",
] as const;

export type AcpUpdateVariant = (typeof ACP_UPDATE_VARIANTS)[number];

/** ACP methods referenced by this mapping. */
export const ACP_METHODS = [
  "session/prompt",
  "session/update",
] as const;

export type AcpMethod = (typeof ACP_METHODS)[number];

// ---------------------------------------------------------------------------
// Value-level mappings
// ---------------------------------------------------------------------------

/**
 * Pebble stop_reason → ACP StopReason returned from session/prompt.
 *
 * awaiting_input / legacy awaiting_approval both map to a clean end of turn.
 * budget_paused and error map to "refusal" — the agent declines to continue —
 * with the precise reason carried on the event stream / _meta, because ACP has
 * no budget- or error-specific stop reason.
 */
export const STOP_REASON_TO_ACP: Readonly<
  Record<StopReason, AcpStopReason>
> = {
  end_turn: "end_turn",
  awaiting_input: "end_turn",
  awaiting_approval: "end_turn",
  budget_paused: "refusal",
  interrupted: "cancelled",
  error: "refusal",
};

/**
 * Pebble tool.end outcome → ACP tool status. `null` means the AGENT emits no
 * status update at all: ACP reserves cancellation for CLIENTS (they mark
 * non-finished calls cancelled themselves upon session/cancel), so an
 * agent-side "cancelled" outcome surfaces as silence plus turn teardown.
 */
export const TOOL_OUTCOME_TO_ACP_STATUS: Readonly<
  Record<ToolOutcome, "pending" | "in_progress" | "completed" | "failed" | null>
> = {
  completed: "completed",
  failed: "failed",
  cancelled: null,
};

// ---------------------------------------------------------------------------
// Event-kind mapping table
// ---------------------------------------------------------------------------

/** One row of the frozen pebble→ACP mapping. */
export interface AcpMappingRow {
  readonly pebbleKind: TurnEventKind;
  /** ACP method carrying the event, or null when no first-class surface exists. */
  readonly acpMethod: AcpMethod | string | null;
  /** session/update variant discriminator when acpMethod is session/update. */
  readonly acpUpdate: AcpUpdateVariant | null;
  readonly notes: string;
}

/**
 * THE table: every pebble event kind → its ACP rendering. Exhaustive over
 * ALL_EVENT_KINDS (enforced by the satisfies clause AND tests/acp.test.ts).
 */
export const ACP_MAPPING = {
  "turn.start": {
    pebbleKind: "turn.start",
    acpMethod: null,
    acpUpdate: null,
    notes:
      "Maps to the session/prompt REQUEST itself; ACP has no start-of-turn notification.",
  },
  "turn.end": {
    pebbleKind: "turn.end",
    acpMethod: "session/prompt",
    acpUpdate: null,
    notes:
      "Becomes the prompt RESPONSE stop reason via STOP_REASON_TO_ACP.",
  },
  "delta.text": {
    pebbleKind: "delta.text",
    acpMethod: "session/update",
    acpUpdate: "agent_message_chunk",
    notes: "text rides one ContentBlock::Text per chunk.",
  },
  "delta.thinking": {
    pebbleKind: "delta.thinking",
    acpMethod: "session/update",
    acpUpdate: "agent_thought_chunk",
    notes: "text rides one ContentBlock::Text per chunk.",
  },
  "tool.start": {
    pebbleKind: "tool.start",
    acpMethod: "session/update",
    acpUpdate: "tool_call",
    notes:
      "id→toolCallId; name+argsSummary render into title/kind (kind via ToolKind heuristic); rawInput omitted.",
  },
  "tool.update": {
    pebbleKind: "tool.update",
    acpMethod: "session/update",
    acpUpdate: "tool_call_update",
    notes: "delta text rides ToolCallContent::Content blocks.",
  },
  "tool.end": {
    pebbleKind: "tool.end",
    acpMethod: "session/update",
    acpUpdate: "tool_call_update",
    notes:
      "status via TOOL_OUTCOME_TO_ACP_STATUS; detail rides content on failure.",
  },
  usage: {
    pebbleKind: "usage",
    acpMethod: "session/update",
    acpUpdate: "usage_update",
    notes:
      "costUsd≠null → cost.amount + currency 'USD'; costUsd=null means UNKNOWN — omit cost, never send 0. Full per-class decomposition rides _meta.pebble.usage.",
  },
  "stage.open": {
    pebbleKind: "stage.open",
    acpMethod: "session/update",
    acpUpdate: "plan",
    notes:
      "Sliding-window narration renders as plan entries: open adds an in_progress entry.",
  },
  "stage.rewrite": {
    pebbleKind: "stage.rewrite",
    acpMethod: "session/update",
    acpUpdate: "plan",
    notes: "Retitles the open plan entry in place.",
  },
  "stage.close": {
    pebbleKind: "stage.close",
    acpMethod: "session/update",
    acpUpdate: "plan",
    notes: "Marks the entry completed.",
  },
  error: {
    pebbleKind: "error",
    acpMethod: null,
    acpUpdate: null,
    notes:
      "No standard ACP error notification; post-retry failures surface via the prompt response stop reason (error→refusal). Optionally attached as _meta.pebble.error.",
  },
  "permission.request": {
    pebbleKind: "permission.request",
    acpMethod: null,
    acpUpdate: null,
    notes:
      "Legacy schema-only compatibility data; never mapped, dispatched, or interpreted.",
  },
  "permission.resolve": {
    pebbleKind: "permission.resolve",
    acpMethod: null,
    acpUpdate: null,
    notes:
      "Legacy schema-only compatibility data; never mapped, dispatched, or interpreted.",
  },
  "queue.changed": {
    pebbleKind: "queue.changed",
    acpMethod: null,
    acpUpdate: null,
    notes: "TUI-native queue state; no ACP surface.",
  },
  "checkpoint.created": {
    pebbleKind: "checkpoint.created",
    acpMethod: null,
    acpUpdate: null,
    notes: "Pebble-native checkpoint ledger; optionally _meta.pebble.checkpoint.",
  },
  "route.decided": {
    pebbleKind: "route.decided",
    acpMethod: null,
    acpUpdate: null,
    notes:
      "Route REASON display is pebble-native (never savings deltas); optionally _meta.pebble.route.",
  },
  "budget.stopped": {
    pebbleKind: "budget.stopped",
    acpMethod: null,
    acpUpdate: null,
    notes:
      "Manifests to ACP as turn.end with stopReason budget_paused (→ refusal); amounts stay on the pebble stream/_meta.",
  },
  "session.compacting": {
    pebbleKind: "session.compacting",
    acpMethod: null,
    acpUpdate: null,
    notes:
      "Renderer-side distinct compacting state; optionally surfaced as an agent_thought_chunk notice.",
  },
} as const satisfies Record<TurnEventKind, AcpMappingRow>;

/** Look up the frozen ACP mapping row for an event kind. Total over all kinds. */
export function acpRowFor(kind: TurnEventKind): AcpMappingRow {
  return ACP_MAPPING[kind];
}
