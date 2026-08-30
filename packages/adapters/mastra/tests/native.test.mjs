import assert from "node:assert/strict";
import test from "node:test";
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { createAdapterLifecycleValidator } from "@caveman-ai/adapter-kit";
import { createModelBoundary } from "@caveman-ai/agent/model-boundary";
import { z } from "zod";
import { createMastraAdapter } from "../src/index.js";

function nativeModel(onRequest) {
  return {
    specificationVersion: "v2",
    provider: "native-test",
    modelId: "native-model",
    supportedUrls: {},
    async doGenerate(options) {
      onRequest(options);
      return {
        content: [{ type: "text", text: "ok" }],
        finishReason: "stop",
        usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
        warnings: [],
      };
    },
    async doStream(options) {
      onRequest(options);
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({
              type: "response-metadata",
              id: "response-1",
              modelId: "native-model",
            });
            controller.enqueue({ type: "text-start", id: "text-1" });
            controller.enqueue({ type: "text-delta", id: "text-1", delta: "ok" });
            controller.enqueue({ type: "text-end", id: "text-1" });
            controller.enqueue({
              type: "finish",
              finishReason: "stop",
              usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
            });
            controller.close();
          },
        }),
      };
    },
  };
}

function toolCallingModel() {
  let calls = 0;
  const next = () => {
    calls += 1;
    return calls === 1;
  };
  return {
    specificationVersion: "v2",
    provider: "native-test",
    modelId: "tool-model",
    supportedUrls: {},
    async doGenerate() {
      const toolStep = next();
      return {
        content: toolStep
          ? [{
            type: "tool-call",
            toolCallId: "native-tool-call",
            toolName: "lookup",
            input: JSON.stringify({ value: 1 }),
          }]
          : [{ type: "text", text: "done" }],
        finishReason: toolStep ? "tool-calls" : "stop",
        usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
        warnings: [],
      };
    },
    async doStream() {
      const toolStep = next();
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            if (toolStep) {
              controller.enqueue({
                type: "tool-call",
                toolCallId: "native-tool-call",
                toolName: "lookup",
                input: JSON.stringify({ value: 1 }),
              });
            } else {
              controller.enqueue({ type: "text-start", id: "text-2" });
              controller.enqueue({ type: "text-delta", id: "text-2", delta: "done" });
              controller.enqueue({ type: "text-end", id: "text-2" });
            }
            controller.enqueue({
              type: "finish",
              finishReason: toolStep ? "tool-calls" : "stop",
              usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
            });
            controller.close();
          },
        }),
      };
    },
  };
}

function assertValidLifecycle(events) {
  const validator = createAdapterLifecycleValidator();
  for (const event of events) validator.accept(event);
  validator.finish();
}

test("exact @mastra/core Agent runs one native model call through Processor", async () => {
  const boundaryRequests = [];
  const providerRequests = [];
  const lifecycle = [];
  const usages = [];
  const processor = createMastraAdapter({
    modelBoundary: createModelBoundary([{
      id: "native-consumer",
      prepare: ({ request }) => {
        boundaryRequests.push(request);
      },
    }]),
    onLifecycle: (event) => lifecycle.push(event),
    onModelUsage: (usage) => usages.push(usage),
  });
  const agent = new Agent({
    id: "native-agent",
    name: "Native Agent",
    instructions: "Answer briefly.",
    model: nativeModel((request) => providerRequests.push(request)),
    inputProcessors: [processor],
    outputProcessors: [processor],
  });

  const result = await agent.generate("hello", { maxSteps: 1 });
  assert.equal(result.text, "ok");
  assert.equal(boundaryRequests.length, 1);
  assert.equal(providerRequests.length, 1);
  assert.equal(providerRequests[0].prompt, boundaryRequests[0]);
  assert.deepEqual(lifecycle.map((event) => event.phase), [
    "run.started",
    "model.requested",
    "model.responded",
    "run.completed",
  ]);
  assert.equal(usages.length, 1);
  assert.equal(usages[0].usage.provider, "native-test");
  assert.equal(usages[0].usage.model, "native-model");
  assert.equal(usages[0].usage.inputTokens, null);
  assert.equal(usages[0].usage.outputTokens, 1);
  assertValidLifecycle(lifecycle);
});

test("exact Agent flow delivers tool-call and successful tool-result chunks", async () => {
  const lifecycle = [];
  const processor = createMastraAdapter({
    onLifecycle: (event) => lifecycle.push(event),
  });
  const lookup = createTool({
    id: "lookup",
    description: "Return one value.",
    inputSchema: z.object({ value: z.number() }),
    outputSchema: z.object({ value: z.number() }),
    execute: async ({ value }) => ({ value }),
  });
  const agent = new Agent({
    id: "native-tool-agent",
    name: "Native Tool Agent",
    instructions: "Use tool once.",
    model: toolCallingModel(),
    tools: { lookup },
    inputProcessors: [processor],
    outputProcessors: [processor],
  });

  const result = await agent.generate("run tool", { maxSteps: 2 });
  assert.equal(result.text, "done");
  assert.deepEqual(lifecycle.map((event) => event.phase), [
    "run.started",
    "model.requested",
    "model.responded",
    "tool.proposed",
    "tool.started",
    "tool.completed",
    "model.requested",
    "model.responded",
    "run.completed",
  ]);
  assertValidLifecycle(lifecycle);
});

test("exact Agent flow delivers tool-error without replacing native run", async () => {
  const lifecycle = [];
  const processor = createMastraAdapter({
    onLifecycle: (event) => lifecycle.push(event),
  });
  const lookup = createTool({
    id: "lookup",
    description: "Fail.",
    inputSchema: z.object({ value: z.number() }),
    execute: async () => { throw new Error("native tool failure"); },
  });
  const agent = new Agent({
    id: "native-tool-error-agent",
    name: "Native Tool Error Agent",
    instructions: "Use tool once.",
    model: toolCallingModel(),
    tools: { lookup },
    inputProcessors: [processor],
    outputProcessors: [processor],
  });

  const result = await agent.generate("run tool", { maxSteps: 2 });
  assert.equal(result.text, "done");
  assert.ok(lifecycle.some((event) => event.phase === "tool.proposed"));
  assert.equal(lifecycle.some((event) => event.phase === "tool.started"), false);
  assert.ok(lifecycle.some((event) => event.phase === "tool.error"));
  assert.equal(lifecycle.some((event) => event.phase === "tool.completed"), false);
  assert.equal(lifecycle.at(-1).phase, "run.completed");
  assertValidLifecycle(lifecycle);
});
