import type {
  AdapterLifecycleEvent,
  AdapterManifestV2,
  AdapterPackage,
} from "@caveman-ai/adapter-kit";
import type { Observability } from "agents/observability";

export interface CloudflareAgentsObserverError {
  readonly stage:
    | "capacity"
    | "event"
    | "identity"
    | "lifecycle_sink"
    | "sequence"
    | "status"
    | "translate";
  readonly eventType: string;
  readonly error: unknown;
}

export interface CloudflareAgentsAdapterOptions {
  /** Existing native sink. Captured once and invoked with its original receiver. */
  readonly observability?: Observability;
  /** Best-effort canonical run observer. Rejection never changes native execution. */
  readonly onLifecycleEvent?: (
    event: AdapterLifecycleEvent,
  ) => void | PromiseLike<void>;
  /** Best-effort translation/sink diagnostic observer. */
  readonly onObserverError?: (
    diagnostic: CloudflareAgentsObserverError,
  ) => void | PromiseLike<void>;
}

export interface CloudflareAgentsAdapter {
  /** Assign directly to an Agent instance's native `observability` field. */
  readonly observability: Observability;
}

export const CLOUDFLARE_AGENTS_VERSION: "0.22.0";
export const manifest: AdapterManifestV2;
export function createCloudflareAgentsAdapter(
  options?: CloudflareAgentsAdapterOptions,
): CloudflareAgentsAdapter;
export const createAdapter: typeof createCloudflareAgentsAdapter;

declare const adapterPackage: AdapterPackage<typeof createCloudflareAgentsAdapter>;
export default adapterPackage;
