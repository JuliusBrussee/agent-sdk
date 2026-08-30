# `@caveman-ai/adapter-strands-agents`

Native Caveman adapter for `@strands-agents/sdk@1.15.0`. It installs one
structural Strands plugin with one `InvokeModelStage.Wrap` middleware. Strands
keeps ownership of its model router, provider call, retry loop, tools, stream,
and cancellation signal; the adapter adds no network hop or second agent loop.

```ts
import { Agent } from "@strands-agents/sdk";
import { createStrandsAgentsAdapter } from "@caveman-ai/adapter-strands-agents";

const cave = createStrandsAgentsAdapter({
  resolveModel: ({ modelId }) => modelId === null
    ? undefined
    : { provider: "bedrock", model: modelId },
  modelBoundary,
  onLifecycle: (event) => lifecycleLog.push(event),
  onModelUsage: ({ usage, identity }) => usageLog.push({ usage, identity }),
});

const agent = new Agent({ model, tools, plugins: [cave] });
```

Use `model` for a fixed single-model agent or `resolveModel` when Strands may
route between concrete `Model` instances. Identity is mandatory when a model
boundary or usage sink is configured. Unknown identity fails closed before
provider I/O for interception and is diagnostic-only for observation.

The boundary may transform messages, system prompt, tool specifications, tool
choice, projected input tokens, and dynamic trailing blocks. Model selection
and the abort signal remain Strands-owned. Stream events and native errors pass
through unchanged; early consumer close forwards `return()` to the next native
middleware layer and records one diagnostic boundary failure. Strands 1.15.0
does not forward that close from its agent loop to the underlying provider
generator, so provider-generator cleanup on consumer close is not claimed.

Strands usage supports input, output, total, cache-read, and cache-write tokens,
but no authoritative reasoning count. The adapter distinguishes providers that
include cache tokens in input from those reporting cache separately. Missing
cache or reasoning counts remain `null`, cost remains `unknown`, and inconsistent
totals are rejected.

`run.completed` is observed only when Strands emits `AgentResultEvent` for a
normal final result. Strands exposes no public run-error/result pair covering
errors, hook cancellation, resume, abort, and consumer break, so `run.error`
remains unsupported and run lifecycle remains experimental. Replay, durable
state, tracing, and compilation are not claimed.

Provider credentials and execution containment remain entirely host-owned.
No local certification or verified-savings claim is created.
