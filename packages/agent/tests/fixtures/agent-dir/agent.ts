import type { AgentDirConfig } from "@caveman-ai/agent";

export default {
  model: "anthropic/claude-haiku-4-5",
  budget: { maxUsd: 0.05 },
  breakers: { repeatedToolCalls: 2 },
  context: {
    // Bare entry: defaults to stability "build" (frozen prefix).
    policy: "Always answer politely.",
    // Explicit turn stability: lives in the live zone.
    today: { value: () => "turn-scoped value", stability: "turn" },
  },
} satisfies AgentDirConfig;
