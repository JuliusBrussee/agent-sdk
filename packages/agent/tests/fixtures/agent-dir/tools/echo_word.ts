import { schema, tool } from "@caveman-ai/agent";

export default tool({
  name: "echo_word",
  description: "Echo one word back.",
  effect: "read",
  input: schema.object({ word: schema.string() }),
  execute: ({ word }: { word: string }) => word,
});
