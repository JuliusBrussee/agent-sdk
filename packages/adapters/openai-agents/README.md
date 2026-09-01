# `@caveman-ai/adapter-openai-agents`

**Observability adapter.** Records lifecycle and usage from a native OpenAI
Agents loop; it does not run a Caveman agent.

Thin native model-boundary adapter for `@openai/agents@0.17.0` and
`@openai/agents-core@0.17.0`.

```ts
import { OpenAIProvider, Runner } from "@openai/agents";
import { createOpenAIAgentsAdapter } from "@caveman-ai/adapter-openai-agents";

const nativeProvider = new OpenAIProvider();
const modelProvider = createOpenAIAgentsAdapter(nativeProvider, {
  modelBoundary,
  onModelUsage({ usage, identity }) {
    recordUsage(identity, usage);
  },
});
const runner = new Runner({ modelProvider });
```

OpenAI Agents keeps its runner, retries, tracing, tools, abort behavior, and
stream protocol. Adapter clones each native model request, enables
`modelSettings.preserveRawUsage`, invokes configured Caveman model boundary,
then calls native model exactly once. Original provider remains available for
provider-specific lifecycle such as `OpenAIProvider.close()`.

Streaming stays pull-driven: provider stream starts on first pull; adapter never
prefetches. Native events, errors, cancellation, and retry advice pass through.
Only terminal `response_done` closes model boundary and emits usage.

Usage comes only from provider `rawUsage` snake_case fields. Missing counters
remain `null`; cached input is separated from uncached input; absent cache-write
counts and cost remain unknown. No normalized SDK zero is treated as provider
evidence.

No run/tool/durable/trace observation. No upstream control state is inspected or
translated. Manifest capabilities stay experimental and uncertified until
adapter-conformance evidence exists.
