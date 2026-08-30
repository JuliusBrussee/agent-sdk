import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { RunnableConfig } from "@langchain/core/runnables";
import { Annotation, END, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import {
  createLangGraphAdapter,
  type LangGraphAdapter,
  type LangGraphUsageObservation,
} from "../src/index.js";

const existing = BaseCallbackHandler.fromMethods({});
const adapter: LangGraphAdapter = createLangGraphAdapter({
  model: { provider: "openai", model: "gpt-5-mini" },
  onUsage(observation: LangGraphUsageObservation) {
    observation.usage.totalTokens satisfies number | null;
  },
});

const composedConfig = adapter.composeConfig({
  callbacks: [existing],
  configurable: { thread_id: "thread-1" },
});
composedConfig.callbacks satisfies NonNullable<RunnableConfig["callbacks"]>;
const config: RunnableConfig = composedConfig;
config satisfies RunnableConfig;

const State = Annotation.Root({
  count: Annotation<number>(),
});
new StateGraph(State)
  .addNode("increment", (state) => ({ count: state.count + 1 }))
  .addEdge(START, "increment")
  .addEdge("increment", END)
  .compile({
    checkpointer: new MemorySaver(),
    transformers: adapter.composeTransformers([]),
  });

adapter.callbackHandler satisfies BaseCallbackHandler;
adapter.composeTransformers() satisfies readonly [typeof adapter.transformer];
