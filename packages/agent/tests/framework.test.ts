import {
  agent,
  auto,
  eval as defineEval,
  output,
  schema,
  tool,
  type AgentDefinition,
  type EvalDefinition,
  type RunOptions,
  type StandardToolSchema,
  type ToolDefinition,
  type TypeBoxOutputToolOptions,
} from "../src/index.js";
import type { ClaudeRunOptions } from "../src/claude.js";
import type { ClientSession } from "eve/client";
import type {
  EveSessionBinding,
} from "../src/adapters.js";

type Assert<T extends true> = T;
type EveBindingCompatible = Assert<ClientSession extends EveSessionBinding ? true : false>;

const lookup = tool({
  name: "lookup",
  description: "Lookup value.",
  input: schema.object({ id: schema.string() }),
  effect: "read",
  execute({ id }) {
    return { id };
  },
});

const defined: AgentDefinition = agent({
  id: "types",
  instructions: "Exact.",
  model: auto(),
  tools: [lookup],
  output: output({
    maxTokens: 100,
    schema: schema.object({
      answer: schema.string(),
      referenceId: schema.union([schema.string(), schema.null()]),
    }),
  }),
});

const typedTool: ToolDefinition = lookup;
const standardInput = {
  "~standard": {
    version: 1 as const,
    vendor: "fixture",
    types: undefined as unknown as { input: { id: string }; output: { id: string } },
    validate(value: unknown) {
      return { value: value as { id: string } };
    },
    jsonSchema: {
      input() {
        return { type: "object", properties: { id: { type: "string" } }, required: ["id"] };
      },
      output() {
        return { type: "object", properties: { id: { type: "string" } }, required: ["id"] };
      },
    },
  },
} satisfies StandardToolSchema<{ id: string }, { id: string }>;
const standardTool = tool({
  name: "standard_lookup",
  description: "Lookup through Standard Schema.",
  input: standardInput,
  effect: "read",
  execute({ id }) {
    return { id };
  },
});
const validateOnlyStandard = {
  "~standard": {
    version: 1 as const,
    vendor: "fixture",
    types: undefined as unknown as { input: { id: string }; output: { id: string } },
    validate(value: unknown) {
      return { value: value as { id: string } };
    },
  },
};
const validateOnlyTool = tool({
  name: "validate_only_lookup",
  description: "Lookup through validation-only Standard Schema.",
  input: validateOnlyStandard,
  inputJSONSchema: schema.object({ id: schema.string() }),
  effect: "read",
  execute({ id }) {
    return { id };
  },
});
const standardOutput = {
  "~standard": {
    version: 1 as const,
    vendor: "fixture",
    types: undefined as unknown as {
      input: { raw: string };
      output: { value: number };
    },
    validate(value: unknown) {
      return { value: { value: Number((value as { raw: string }).raw) } };
    },
    jsonSchema: {
      input() {
        return { type: "object", properties: { raw: { type: "string" } }, required: ["raw"] };
      },
      output() {
        return { type: "object", properties: { value: { type: "number" } }, required: ["value"] };
      },
    },
  },
} satisfies StandardToolSchema<{ raw: string }, { value: number }>;
const standardOutputTool = tool({
  name: "standard_output_lookup",
  description: "Validate and transform output through Standard Schema.",
  input: schema.object({ id: schema.string() }),
  output: standardOutput,
  effect: "read",
  execute({ id }) {
    return { raw: id };
  },
});
const standardOutputResult: { value: number } | Promise<{ value: number }> =
  standardOutputTool.execute({ id: "7" });
const invalidTypeBoxInput = schema.object({});
const invalidTypeBoxOutput = schema.string();
const invalidTypeBoxOutputTool: TypeBoxOutputToolOptions<
  typeof invalidTypeBoxInput,
  typeof invalidTypeBoxOutput
> = {
  name: "invalid_typebox_output",
  description: "Must not type-check.",
  input: invalidTypeBoxInput,
  output: invalidTypeBoxOutput,
  effect: "read",
  // @ts-expect-error TypeBox output contract constrains execute result.
  execute: () => 7,
};
const typedEval: EvalDefinition = defineEval({
  id: "types",
  input: "x",
  quality: [{ type: "contains", fragments: ["x"] }],
});
const callerPathOptions: RunOptions = {
  // @ts-expect-error descendant routing is framework-private
  subagentPath: ["child"],
};
const callerDepthOptions: RunOptions = {
  // @ts-expect-error recursion state is framework-private
  subagentDepth: 1,
};
const callerPlanOptions: RunOptions = {
  // @ts-expect-error compiled plans enter through validated CLI/compiler path
  candidatePlan: {},
};
const callerBuildOptions: RunOptions = {
  // @ts-expect-error build identity enters through validated CLI/compiler path
  lockedBuild: {},
};
const callerClaudeBuildOptions: ClaudeRunOptions = {
  // @ts-expect-error Claude Cave Build identity enters through validated compiler path
  lockedBuild: {},
};

void defined;
void typedTool;
void standardTool;
void validateOnlyTool;
void standardOutputTool;
void standardOutputResult;
void invalidTypeBoxOutputTool;
void typedEval;
void callerPathOptions;
void callerDepthOptions;
void callerPlanOptions;
void callerBuildOptions;
void callerClaudeBuildOptions;
void (null as unknown as EveBindingCompatible);
