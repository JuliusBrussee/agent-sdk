import { agent, auto, routine, schema, tool } from "../../dist/index.js";

// The original step a witnessed-deterministic routine replaces. It stays the
// deopt target: the composed tool must be able to reach it unchanged.
const lookup = tool({
  name: "order_status",
  description: "Look up an order status.",
  input: schema.object({ order: schema.string() }),
  effect: "read",
  execute: ({ order }) => `original:${order}`,
});

export default agent({
  id: "routine-sandbox",
  instructions: "Run requested tool.",
  model: auto(),
  tools: [
    routine(
      lookup,
      ({ order }) => `routine:${order}`,
      { guard: ({ order }) => order.startsWith("A") },
    ),
  ],
  sandbox: "required",
});
