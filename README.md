<p align="center">
  <img src="docs/assets/caveman-logo-banner.png" alt="Caveman" width="720">
</p>

<p align="center">
  <strong>build agent once. agent learn to spend less.</strong>
</p>

<p align="center">
  The Caveman Agent SDK: a TypeScript agent framework that meters every call,<br>
  caps spend before it happens, survives crashes with a receipt, and compiles<br>
  itself cheaper from its own traces. Keep your provider. Brain big. Bill small.
</p>

<p align="center">
  <a href="#license"><img src="https://img.shields.io/badge/license-MIT-green?style=flat" alt="MIT"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A522.19-blue?style=flat" alt="Node 22.19+">
  <img src="https://img.shields.io/badge/tests-530_passing-brightgreen?style=flat" alt="530 tests">
  <img src="https://img.shields.io/badge/local_savings-always_inferred-orange?style=flat" alt="savings stay inferred">
</p>

<p align="center">
  <a href="#see-it">See it</a> ·
  <a href="#start">Start</a> ·
  <a href="#what-you-get">What you get</a> ·
  <a href="#develop">Develop</a> ·
  <a href="#packages">Packages</a> ·
  <a href="#honesty-boundary">Honesty</a> ·
  <a href="#license">License</a>
</p>

---

## See it

Smallest agent. Whole thing.

```ts
import { agent, auto } from "@caveman-ai/agent";

export default agent({
  id: "support",
  instructions: "Answer from policy. Never invent policy.",
  model: auto(),
});
```

```ts
import support from "./agent.js";
import { run } from "@caveman-ai/agent";

const result = await run(support, "Can I get a refund?");
console.log(result.text);
console.log(result.contextBill); // every run ends with a receipt
```

Works on a machine with nothing but Node and a provider credential. Every model
call — root, subagent, retry — lands in the receipt at public catalog list
prices. A run that crashes after spending still hands you the partial receipt.

## Start

```bash
npm create @caveman-ai/agent@latest my-agent
cd my-agent
npm run doctor
npm run dev
```

Or install the framework directly:

```bash
npm install @caveman-ai/agent
```

Full API and safety contract: [packages/agent/README.md](./packages/agent/README.md).

## What you get

- **Receipts, not vibes.** `result.contextBill` on every run; per-call ledger
  at catalog list prices; partial receipt survives failure.
- **Spend caps that fail closed.** `maxCostUsd` reserves worst-case before each
  call, settles measured cost after. A model the catalog cannot price cannot be
  capped — the call refuses instead of spending $0 of budget.
- **Durable runs.** Journaled intents with fsync before every call; crash, then
  resume with the meter preloaded — never re-reserve, never lose spend.
- **Directory conventions.** `loadAgentDir` turns a folder of markdown + tools
  into an agent; skills ship descriptions in the frozen prefix, bodies load on
  demand.
- **Cache planning.** Provider cache breakpoints planned statically, checked
  against Go-fixture parity; hints only, model-visible bytes never change.
- **Profile-guided compilation.** `npm run build` profiles, searches, freezes a
  plan, then proves it on an untouched holdout before it can be claimed.
- **Exact-pinned adapters.** Pi, Claude Agent SDK, Vercel AI SDK, Eve, Mastra.
- **Sandboxed tools.** Restricted-tool policy with a written
  [threat model](./packages/agent/SANDBOX_THREAT_MODEL.md).

## Develop

Requires Node.js 22.19+.

```bash
npm ci --prefix packages/agent
npm ci --prefix packages/create-caveman-agent
npm ci --prefix examples/coding-agent --ignore-scripts
npm test
npm run pack:check
```

`npm test` checks the generated provider catalog, 507 runtime tests, 10
compiler-replay tests, the deterministic replay artifact, the initializer
suite, and the example agent. macOS restricted-tool tests require working
`sandbox-exec` and loopback access.

## Packages

- `packages/agent` — `@caveman-ai/agent` v0.2 compiler/runtime.
- `packages/create-caveman-agent` — zero-runtime-dependency project initializer.
- `packages/shared` — pinned wire schemas and provider-catalog snapshot required
  to regenerate and verify Agent SDK artifacts.
- `internal/agentbench/corpus` — pinned Apache-2.0 evaluation subset used only by
  deterministic compiler replay.

## Honesty boundary

Local execution and replay evidence remain `inferred`. The Agent SDK does not
publish a savings percentage. `verifiedSavingsUsd` remains `0` until active real
traffic passes Caveman Cloud rollout and ledger gates. Unknown price/model/
runtime state fails closed or returns an honest zero; it is never guessed.

## License

MIT. The Anthropic Claude Agent SDK dependency remains governed by Anthropic
terms; see the framework README and sandbox threat model for the exact boundary.
