/**
 * @pebble-agent/protocol — the PEBBLE wire and storage contract, VERSION 1.
 *
 * ██ FROZEN ██
 *
 * This contract was frozen at version 0.1.0 (spine unit S2, "contract
 * freeze"). Every downstream workstream — sessions, TUI, checkpoints, router,
 * embed/SDK, adapters, conformance — compiles against THESE types ONLY.
 *
 * FROZEN means: any change that alters the shape, field names, field types,
 * enum membership, ordering constraints (seq), or meaning of anything exported
 * from this package is BREAKING and requires a new major version per the
 * README versioning policy. Additive optional fields may land in minor
 * versions; runtime validators deliberately tolerate unknown extra properties
 * so older readers keep reading newer streams.
 *
 * Golden fixtures under fixtures/ are the acceptance artifacts for any change:
 * every event kind has exactly one fixture and tests round-trip every fixture
 * encode → decode → validate → re-encode byte-stably.
 *
 * License: Apache-2.0. See LICENSE and README.md.
 */

export { PROTOCOL_VERSION } from "./events.ts";
export type {
  BudgetStoppedEvent,
  CheckpointCreatedEvent,
  DeltaTextEvent,
  DeltaThinkingEvent,
  EnvelopeFields,
  ErrorEvent,
  PermissionDecision,
  PermissionRequestEvent,
  PermissionResolveEvent,
  QueueChangedEvent,
  RouteDecidedEvent,
  SessionCompactingEvent,
  StageCloseEvent,
  StageOpenEvent,
  StageRewriteEvent,
  StopReason,
  ToolEndEvent,
  ToolOutcome,
  ToolStartEvent,
  ToolUpdateEvent,
  TurnEndEvent,
  TurnEvent,
  TurnEventKind,
  TurnStartEvent,
  Usage,
  UsageEvent,
} from "./events.ts";
export {
  ALL_EVENT_KINDS,
  isStopReason,
  isTurnEvent,
  isUsage,
  PERMISSION_DECISIONS,
  STOP_REASONS,
  TOOL_OUTCOMES,
} from "./events.ts";

export type { SessionEntry, SessionRole } from "./session.ts";
export { SESSION_ROLES, isSessionEntry } from "./session.ts";

export type {
  JsonlDecoderOptions,
  ProtocolErrorCode,
  RpcErrorObject,
  RpcMessage,
  RpcNotification,
  RpcRequest,
  RpcResponse,
} from "./framing.ts";
export {
  DEFAULT_MAX_FRAME_BYTES,
  decodeFrames,
  encodeFrame,
  encodeFrameText,
  EVENT_NOTIFICATION_METHOD,
  isRpcMessage,
  isRpcNotification,
  isRpcRequest,
  isRpcResponse,
  JsonlDecoder,
  ProtocolError,
  rpcErrorResponse,
  rpcNotification,
  rpcRequest,
  rpcResponse,
  RPC_ERROR_CODES,
  unwrapEvent,
} from "./framing.ts";

export type {
  AcpMethod,
  AcpMappingRow,
  AcpStopReason,
  AcpUpdateVariant,
} from "./acp.ts";
export {
  ACP_MAPPING,
  ACP_METHODS,
  ACP_STOP_REASONS,
  ACP_UPDATE_VARIANTS,
  acpRowFor,
  STOP_REASON_TO_ACP,
  TOOL_OUTCOME_TO_ACP_STATUS,
} from "./acp.ts";

export type {
  SessionEventSequenceCoordinatorOptions,
  SessionEventSequenceSummary,
  TurnEventSequenceErrorCode,
  TurnEventSequenceSummary,
  TurnEventSequenceValidatorOptions,
} from "./sequence.ts";
export {
  DEFAULT_MAX_OPEN_LIFECYCLES,
  DEFAULT_MAX_RETAINED_IDENTITY_BYTES,
  DEFAULT_MAX_SEEN_LIFECYCLE_IDS,
  DEFAULT_MAX_SEEN_SESSION_TOOL_IDS,
  SessionEventSequenceCoordinator,
  TURN_EVENT_SEQUENCE_ERROR_CODES,
  TurnEventSequenceError,
  TurnEventSequenceValidator,
} from "./sequence.ts";
