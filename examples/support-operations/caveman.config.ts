import { defineBuild } from "@caveman-ai/agent/build";

export default defineBuild({
  entry: "src/agent.ts",
  evals: "evals/*.eval.ts",
  allowedModels: ["anthropic/claude-haiku-4-5"],
  maxSearchCostUsd: 2,
  requiredFixturePassRate: 1,
  qualityRetention: 0.98,
});
