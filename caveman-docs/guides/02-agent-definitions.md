# Agent definitions

`agent()` returns an immutable `AgentDefinition`. It is a value, not a running
thing: `run()`, `stream()`, `runLocked()`, the compiler, the server, and every
adapter all take the same definition.

```ts
import { agent, auto } from "@caveman-ai/agent";

export default agent({
  id: "support",
  instructions: "Answer from policy. Never invent policy.",
  model: auto(),
});
```

## Fields

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `id` | `string` | required | Stable identity. Enters build and durable identity |
| `instructions` | `string \| FileSource` | required | Raw markdown. `file("./instructions.md")` reads from disk |
| `model` | `Auto \| string \| Model<Api>` | required | `"provider/model"`, or `auto()` |
| `reasoning` | `"off" \| "minimal" \| "low" \| "medium" \| "high"` | `"low"` | Model-capability aware; unknown capability fails before provider spend |
| `tools` | `readonly ToolDefinition[]` | `[]` | See [Tools](04-tools.md) |
| `contexts` | `readonly ContextDefinition[]` | `[]` | See [Context and output](06-context-and-output.md) |
| `memory` | `MemoryDefinition` | absent | See [Memory](07-memory.md) |
| `output` | `OutputDefinition` | absent | Token ceiling plus optional schema |
| `sandbox` | `"required" \| "fixture" \| "host"` | `"required"` | See [Sandbox and security](13-sandbox-and-security.md) |

The exact declaration, with the full JSDoc on `sandbox`, is in the
[API reference](../reference/api/agent/index.md).

## Model selection

```ts
model: "openai/gpt-5.4"      // explicit provider/model
model: auto()                 // configured/default resolution
```

`auto()` resolution order: `CAVE_MODEL`, then `.caveman/provider.json`, then the
baseline model for the sole supported provider credential. It performs no task
classification and no quality-based routing.

For per-call selection, `RunOptions.modelRouter` runs before every root working
model request — before budget reservation and before provider I/O. Returned
models must exist in the configured Pi catalog and stay within the initial
provider; unknown or cross-provider decisions fail closed.

## Sandbox posture

```ts
sandbox: "required"   // default: tool closures run in network-denied isolated workers
sandbox: "fixture"    // trusted tests only; effect: "write" tools are blocked, not run
sandbox: "host"       // explicit opt-in; in-process, uncontained, writes execute
```

A `required` agent with tools must pass `RunOptions.entryPath` pointing at the
module that exports the definition. The CLI supplies it automatically.

`host` is never a default, is refused under a `required` ancestor
(`cave_host_sandbox_nested_under_required`), and makes a build lock-ineligible
(`cave_host_sandbox_lock_ineligible`). Host execution is not isolation.

## Subagents

```ts
import { agent, subagent } from "@caveman-ai/agent";

const researcher = agent({ id: "researcher", instructions: "…", model: auto() });

const lead = agent({
  id: "lead",
  instructions: "Delegate research, then answer.",
  model: auto(),
  tools: [subagent({
    name: "research",
    description: "Delegate a research task.",
    agent: researcher,
    timeoutMs: 120_000,
    maxCalls: 4,
    maxCostUsd: 0.25,
  })],
});
```

A subagent is a tool. Under a USD-metered run its `maxCostUsd` wallet is carved
out of the parent's **remaining** budget when the child spawns, and the unspent
remainder returns to the parent when the child finishes.

Root-tree ceilings live on `RunOptions`:

| Option | Effect |
| --- | --- |
| `maxSubagentDepth` | Graph depth from the root. Defaults to **2**, capped at `ABSOLUTE_SUBAGENT_DEPTH_LIMIT` (**8**) — delegation multiplies spend, so a deeper graph says so explicitly |
| `maxSubagentInvocations` | One shared monotonic counter across every subagent tool and depth. Failures and aborts still consume an admission once the child starts |
| `maxConcurrentSubagents` | Simultaneously active descendants. Reservation is synchronous, released on success, failure, or abort |

Descendant model calls reserve catalog-priced worst-case spend against every
ancestor cap before the provider call. Every turn must report complete usage and
the exact requested provider and model.

## Definition transforms

```ts
import { applyAgentDefinitionTransforms } from "@caveman-ai/agent";
```

A transform takes a definition and returns a definition. This is the supported
way to layer optional behavior — workspace plugins, environment-derived skills —
without the core runtime learning about the filesystem. See
[Plugins and skills](15-plugins-and-skills.md).

## Running a definition

| Entry point | Use |
| --- | --- |
| `run(definition, input, options?)` | One-shot. Returns `RunResult` with the receipt |
| `stream(definition, input, options?)` | Typed event iterator |
| `runLocked(definition, input, build, options?)` | Validated Cave Build execution |
| `createConversation()` | Explicit multi-turn state passed via `RunOptions.conversation` |
| `routine(...)` | Named repeatable outcome wrapper; see `routineOutcomes` |

A directory-loaded definition carries run defaults (budget, breakers, generated
sandbox entry, receipt printing). Explicit `RunOptions` always win, and a
caller-supplied `maxCostUsd` keeps the default budget out because the two
contracts are mutually exclusive.

## Inputs

`AgentInput` accepts a string or structured multimodal parts. Invalid parts fail
closed with `cave_input_part_invalid`; base64 payloads that do not decode fail
with `cave_input_base64_invalid`. See the
[`@caveman-ai/agent/input` reference](../reference/api/agent/input.md).

## What is deliberately absent

There is no hook surface. Lifecycle callbacks from other frameworks port to your
own code around `run()` or `stream()`. Channels, schedules, cron, webhooks, and
connections are not part of v1 — keep them where they are and call `run()`.
