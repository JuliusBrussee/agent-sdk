# Programmatic tools

Programmatic mode replaces a wall of provider-visible JSON tools with **one**
tool named `caveman_code`. The model writes a bounded JavaScript cell and calls
your tools through typed proxies inside it.

```ts
import {
  createCodingAgent,
  runCodingTurn,
  startCodingSession,
} from "@caveman-ai/agent/code";

const codingAgent = createCodingAgent({
  workspace: process.cwd(),
  toolMode: "programmatic",
});

const session = await startCodingSession(codingAgent);
await runCodingTurn(session, "Find failing tests and fix the root cause.");
```

Transport wrapping is automatic. There is no second option to set.

## What it does not bypass

Nested calls still go through the runtime's canonical tool dispatcher. Code
cells do not bypass:

- schema validation (input and output),
- effect policy,
- call limits and breakers,
- timeouts,
- abort signals,
- receipts.

The receipt records **both** the composite cell and every nested call, so a cell
that made six tool calls shows seven entries, not one.

## Speculative reads

While the provider is still streaming the cell's source, a complete literal
`effect: "read"` call may start early.

Never speculated:

- writes, idempotent operations, and external calls;
- any call whose arguments depend on a variable;
- a read that could follow a write.

Declaring `effect: "read"` in this mode also means the work is safe to **start
and abandon** — it may run even when the generated cell is later discarded.
Unknown or ambiguous stream provenance executes fresh work instead of reusing a
stale speculation.

Turn it off while keeping programmatic mode:

```ts
createCodingAgent({ workspace, toolMode: "programmatic", speculativeToolCalls: false });
```

Or return to ordinary JSON tools:

```ts
createCodingAgent({ workspace, toolMode: "direct" });
```

## Containment

Programmatic mode supports **host** agents only. Host execution and the code
cell's Worker are **not** isolation boundaries. When containment matters, use an
ordinary `sandbox: "required"` agent with direct tools.

## Embedding it without the coding agent

```ts
import {
  createProgrammaticToolRuntime,
  programmaticToolInstructions,
  PROGRAMMATIC_TOOL_NAME,
} from "@caveman-ai/agent/programmatic-tools";
```

| Export | Purpose |
| --- | --- |
| `createProgrammaticToolRuntime` | Builds the composite tool and its dispatch kernel from your tool list |
| `programmaticToolInstructions` | The instruction block that teaches the model the cell contract |
| `programmaticToolMetadata` | Static metadata about the composite tool |
| `createProgrammaticToolErrorWrapper` | Wraps nested errors so a cell sees a stable shape |
| `ProgrammaticSpeculationScope` | Scope object owning launch/claim of speculative reads |
| `ProgrammaticToolStats` | Per-run counters (cells, nested calls, speculation hits) |
| `PROGRAMMATIC_TOOL_NAME` | `"caveman_code"` |

Full signatures:
[`@caveman-ai/agent/programmatic-tools`](../reference/api/agent/programmatic-tools.md).

## Nested dispatch from a tool

Any tool can declare `nestedTools` and dispatch through the kernel:

```ts
async execute(input, signal, context) {
  const files = await context.dispatch("list_files", { dir: input.dir });
  return files;
}
```

`context.dispatch(name, input, { signal, claimSpeculation })` runs the nested
tool through the same canonical path. `claimSpeculation: true` claims a matching
read the kernel already admitted during streaming; missing or ambiguous
provenance fails closed and executes normally. A cell that leaves nested calls
in flight at exit fails with `cave_program_nested_calls_unquiesced`; dispatch
outside a composite context fails with `cave_nested_tool_dispatch_unavailable`.
