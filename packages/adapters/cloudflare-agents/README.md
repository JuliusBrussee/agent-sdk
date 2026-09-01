# `@caveman-ai/adapter-cloudflare-agents`

**Observability adapter.** Records lifecycle and usage from a native Cloudflare
Agents loop; it does not run a Caveman agent.

Small native observability adapter for `agents@0.22.0`.

```ts
import { Agent, type AgentNamespace } from "agents";
import { createCloudflareAgentsAdapter } from "@caveman-ai/adapter-cloudflare-agents";

const caveman = createCloudflareAgentsAdapter({
  onLifecycleEvent(event) {
    console.log(event);
  },
});

export class SupportAgent extends Agent<Env> {
  observability = caveman.observability;
}

export interface Env {
  SupportAgent: AgentNamespace<SupportAgent>;
}
```

Cloudflare remains sole owner of Durable Object execution, workflows, alarms,
routing, retries, tools, model calls, AI SDK integration, aborts, and streams.
Adapter adds no proxy or model call. Existing observability receives original
receiver, arguments, return value, and thrown value unchanged.

Mapped native pairs:

- `chat:turn:start` → `chat:turn:finish`
- `fiber:run:started` → `fiber:run:completed|failed|interrupted`

Only stable native `requestId` and `fiberId` values become canonical run
identity. Invalid identity, unknown terminal status, unmatched pair, or bounded
observer saturation produces diagnostic skip. Observer work is detached,
bounded, and cannot replace native execution.

Workflow/control metadata, host decisions, recovery records, and partial tool
events remain untouched. Cloudflare lifecycle capability hooks do not prove a
checkpoint or session commit, so adapter exports no lifecycle capability and
claims no durability or replay support. Model boundary, context, token usage,
and stream observation belong model-layer adapter (for Cloudflare AI SDK usage,
compose `@caveman-ai/adapter-vercel-ai-sdk`).

Manifest capabilities remain experimental and uncertified.
