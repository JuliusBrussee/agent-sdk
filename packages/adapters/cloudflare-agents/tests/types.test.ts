import type { AdapterLifecycleEvent } from "@caveman-ai/adapter-kit";
import type { Observability, ObservabilityEvent } from "agents/observability";
import {
  createCloudflareAgentsAdapter,
  type CloudflareAgentsAdapter,
  type CloudflareAgentsObserverError,
} from "@caveman-ai/adapter-cloudflare-agents";

const native: Observability = { emit(_event: ObservabilityEvent) {} };
const adapter: CloudflareAgentsAdapter = createCloudflareAgentsAdapter({
  observability: native,
  onLifecycleEvent(event: AdapterLifecycleEvent) {
    event.phase satisfies "run.started" | "run.completed" | "run.error" |
      "model.requested" | "model.responded" | "model.error" |
      "tool.proposed" | "tool.started" | "tool.completed" | "tool.error" |
      "checkpoint.committed" | "session.committed";
  },
  onObserverError(error: CloudflareAgentsObserverError) {
    error.stage satisfies CloudflareAgentsObserverError["stage"];
  },
});

const composed: Observability = adapter.observability;
const event: ObservabilityEvent = {
  type: "fiber:run:started",
  payload: { fiberId: "fiber-1", fiberName: "fixture" },
  timestamp: Date.now(),
};
composed.emit(event);
