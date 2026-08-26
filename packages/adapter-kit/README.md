# `@caveman-ai/adapter-kit`

Shared, framework-neutral contract for Caveman adapter packages.

Each adapter publishes one exact upstream version and a complete capability
manifest. Capability states are `unsupported`, `experimental`, or `certified`.
Only a conformance report digest can move a capability to `certified`, and
`registry.require(id, capability)` refuses every other state.

```js
import { createAdapterRegistry } from "@caveman-ai/adapter-kit";
import vercel from "@caveman-ai/adapter-vercel-ai-sdk";

const adapters = createAdapterRegistry();
adapters.register(vercel);

// Introspection may see experimental packages.
console.log(adapters.get("vercel-ai-sdk")?.manifest.capabilities);

// Authorization remains fail-closed until conformance evidence exists.
adapters.require("vercel-ai-sdk", "run");
```

Registry does not turn local execution into verified savings. Adapter results
remain subject to core runtime accounting and claim rules.
