# `@caveman-ai/adapter-mastra`

Exact-pinned Caveman adapter for `@mastra/core@1.55.0` `Agent`.

```bash
npm install @caveman-ai/agent @caveman-ai/adapter-mastra @mastra/core@1.55.0
```

```js
import { createAdapter } from "@caveman-ai/adapter-mastra";
```

Adapter forces processor retries to zero, supports explicit `maxSteps`, and
requires complete terminal usage evidence before returning.
