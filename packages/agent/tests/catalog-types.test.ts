import type { CatalogModelFacts } from "../src/catalog.js";

// All closed lifecycle states are part of the generated artifact contract.
// In particular, discovered and retired rows must compile so runtime code can
// see and reject them instead of dropping them during generation.
const discovered = {
  lifecycle: "discovered",
  messagesAPI: "supported",
  adaptiveThinking: "unknown",
  manualThinking: "unknown",
} satisfies CatalogModelFacts;

const retired = {
  ...discovered,
  lifecycle: "retired",
} satisfies CatalogModelFacts;

void discovered;
void retired;
