import type { AgentDefinition } from "./index.js";
import type { ToolDefinition } from "./primitives.js";
import { toolSchemaSemanticsVerified } from "./tool-internal.js";

const TOOL_IMPLEMENTATION_SOURCE = Symbol.for(
  "@caveman-ai/agent:tool-implementation-source",
);

function subagentChildren(tool: ToolDefinition): AgentDefinition[] {
  const children: AgentDefinition[] = [];
  if (tool.runtime?.kind === "subagent") {
    children.push(tool.runtime.definition as AgentDefinition);
  }
  for (const nested of tool.nestedTools ?? []) {
    if (nested.runtime?.kind === "subagent") {
      children.push(nested.runtime.definition as AgentDefinition);
    }
  }
  return children;
}

export function agentGraphHasSubagents(root: AgentDefinition): boolean {
  const visited = new Set<AgentDefinition>();
  const visit = (definition: AgentDefinition): boolean => {
    if (!definition || visited.has(definition)) return false;
    visited.add(definition);
    for (const declared of definition.tools ?? []) {
      const children = subagentChildren(declared);
      if (children.length > 0) return true;
      if (children.some(visit)) return true;
    }
    return false;
  };
  return visit(root);
}

/** True when any reachable tool depends on mutable validator state without a digest. */
export function graphHasUnverifiedToolSchemaSemantics(root: AgentDefinition): boolean {
  const visited = new Set<AgentDefinition>();
  const visit = (definition: AgentDefinition): boolean => {
    if (!definition || visited.has(definition) || !Array.isArray(definition.tools)) return false;
    visited.add(definition);
    for (const declared of definition.tools) {
      const inspect = (tool: ToolDefinition): boolean =>
        !toolSchemaSemanticsVerified(tool) || (tool.nestedTools ?? []).some(inspect);
      if (inspect(declared)) return true;
      if (subagentChildren(declared).some(visit)) return true;
    }
    return false;
  };
  return visit(root);
}

export function validateAgentGraph(root: AgentDefinition): void {
  // Memoize per inherited containment posture: the same child definition
  // reached under a sandbox-required ancestor must be re-checked, not skipped.
  const visited = [new Set<AgentDefinition>(), new Set<AgentDefinition>()];
  const active = new Set<AgentDefinition>();

  const visit = (
    definition: AgentDefinition,
    depth: number,
    sandboxRequired: boolean,
  ): void => {
    if (!definition || definition.kind !== "agent" ||
        !Array.isArray(definition.tools)) {
      throw new Error("cave_agent_definition_invalid");
    }
    if (depth > 8) throw new Error("cave_subagent_depth_limit");
    if (active.has(definition)) throw new Error("cave_subagent_definition_cycle");
    // Host mode is an opt-in the root makes for itself. A descendant cannot use
    // it to run closures outside an ancestor's required containment.
    if (sandboxRequired && definition.sandbox === "host") {
      throw new Error("cave_host_sandbox_nested_under_required");
    }
    const memo = visited[sandboxRequired ? 1 : 0]!;
    if (memo.has(definition)) return;
    active.add(definition);
    const childSandboxRequired = sandboxRequired ||
      definition.sandbox === "required";
    const names = new Set<string>();
    const validateTool = (declared: ToolDefinition): void => {
      if (!declared || declared.kind !== "tool" ||
          typeof declared.name !== "string") {
        throw new Error("cave_tool_definition_invalid");
      }
      if (declared.name.startsWith("cave_")) {
        throw new Error(`cave_reserved_tool_name:${declared.name}`);
      }
      if (typeof Reflect.get(declared, TOOL_IMPLEMENTATION_SOURCE) !== "string") {
        throw new Error(`cave_untrusted_tool_definition:${declared.name}`);
      }
      for (const nested of declared.nestedTools ?? []) validateTool(nested);
      for (const child of subagentChildren(declared)) {
        visit(child, depth + 1, childSandboxRequired);
      }
    };
    for (const declared of definition.tools) {
      if (names.has(declared.name)) throw new Error("cave_duplicate_tool_name");
      names.add(declared.name);
      validateTool(declared);
    }
    active.delete(definition);
    memo.add(definition);
  };

  visit(root, 0, false);
}

/**
 * True when any agent in the graph opts into host mode.
 *
 * Lock eligibility is a property of the whole graph, not of its root: a host
 * subagent runs its tool closures in the host process just as a host root does,
 * so its evidence shows no containment either. Follows the same subagent edges
 * as `validateAgentGraph`, with no depth ceiling — the ceiling is a runtime
 * policy, and answering "no host below 8" would be a way to hide one. The
 * visited set (not path-scoped, because the answer is per definition) is what
 * terminates cycles. It runs before `validateAgentGraph` has, so a malformed
 * `tools` list reads as "no host here" and stays that function's rejection.
 */
export function graphUsesHostSandbox(root: AgentDefinition): boolean {
  const visited = new Set<AgentDefinition>();

  const visit = (definition: AgentDefinition): boolean => {
    if (!definition || visited.has(definition)) return false;
    visited.add(definition);
    if (definition.sandbox === "host") return true;
    if (!Array.isArray(definition.tools)) return false;
    for (const declared of definition.tools) {
      for (const child of subagentChildren(declared)) {
        if (visit(child)) return true;
      }
    }
    return false;
  };

  return visit(root);
}
