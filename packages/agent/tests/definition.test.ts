import {
  agent,
  applyAgentDefinitionTransforms,
  type AgentDefinitionTransform,
} from "../src/index.js";

const definition = agent({
  id: "typed-transform",
  instructions: "Exact.",
  model: "anthropic/faux-1",
  sandbox: "fixture",
});
const transform: AgentDefinitionTransform = {
  id: "typed",
  apply: (current) => current,
};

applyAgentDefinitionTransforms(definition, [transform]);
