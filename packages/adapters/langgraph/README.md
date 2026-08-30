# `@caveman-ai/adapter-langgraph`

Native, observation-only Caveman adapter for LangGraph.js. It attaches one
LangChain callback handler and one LangGraph v3 stream-transformer factory. It
does not wrap `invoke`, replace graph execution, proxy model traffic, mutate
context, or own retries.

Tested pins:

- `@langchain/langgraph@1.4.13`
- `@langchain/core@1.2.9`

```ts
import { createLangGraphAdapter } from "@caveman-ai/adapter-langgraph";

const cave = createLangGraphAdapter({
  model: { provider: "openai", model: "gpt-5-mini" },
  onLifecycle: (event) => lifecycleLog.push(event),
  onUsage: ({ usage, identity }) => usageLog.push({ usage, identity }),
  onStreamEvent: (event) => streamLog.push(event),
});

const graph = builder.compile({
  checkpointer,
  transformers: cave.transformers,
});

const result = await graph.invoke(input, cave.composeConfig({
  callbacks: existingCallbacks,
  configurable: { thread_id: "thread-1" },
}));
```

`composeCallbacks`, `composeConfig`, and `composeTransformers` append without
discarding existing native values. Observation sink failures are contained and
never replace graph results or thrown errors.

Usage comes only from `AIMessage.usage_metadata`. Missing cache details remain
`null`; input tokens are not presented as disjoint until both cache-read and
cache-creation counts exist. Missing reasoning or total counts remain `null`.
Cost stays `unknown`. Static model identity supports single-model graphs;
`resolveModel` supports multi-model graphs. Native metadata hints are used only
when both provider and model are present.

Manifest states are experimental candidates. No local certification is minted.
