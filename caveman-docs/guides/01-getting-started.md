# Getting started

## Requirements

- Node.js `>=22.19.0`. The Eve adapter lane needs `>=24`.
- One provider credential in the environment:
  `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GEMINI_API_KEY` / `GOOGLE_API_KEY`.
- Nothing else. No Caveman account, no hosted service.

## Option A — scaffold a project

```bash
npm create @caveman-ai/agent@latest my-agent
cd my-agent
npm run doctor      # zero provider calls
npm run dev
```

The initializer writes one source file, a starter eval, a strict build config, a
provider choice, and installs dependencies. Exactly one detected credential is
selected silently; zero or several prompt once. Secrets are never printed or
written.

Non-interactive:

```bash
npm create @caveman-ai/agent@latest my-agent -- --provider anthropic
npm create @caveman-ai/agent@latest my-agent -- --provider openai --no-install
```

Supported providers: `anthropic`, `openai`, `google`.

> `@caveman-ai/agent` v0.2 is not published to npm yet. Registry installs may
> expose an older surface; use this checkout when testing anything described in
> these docs.

## Option B — run from this repository

```bash
git clone https://github.com/JuliusBrussee/agent-sdk.git
cd agent-sdk
npm ci
npm --prefix packages/pebble-protocol run build
npm ci --prefix examples/coding-agent --ignore-scripts
npm test
```

## The smallest agent

```ts
import { agent, auto, run } from "@caveman-ai/agent";

const support = agent({
  id: "support",
  instructions: "Answer from policy. Never invent policy.",
  model: auto(),
});

const result = await run(support, "Can I get a refund?");
console.log(result.text);
console.log(result.receipt);
```

`auto()` resolves configuration in this order:

1. `CAVE_MODEL`
2. `.caveman/provider.json`
3. The baseline model for the sole supported provider credential present.

It never classifies a task and never routes between models on quality.

## What the first run tells you

On a machine with only Node and a provider key:

```text
cave: observe-only — engine/gateway unavailable; transforms and gateway
telemetry off (provider usage and local context estimates remain available)
```

`RunResult.mode` is `"observe-only"`. The call went straight to your provider.
Provider usage and local context estimates are still there; no efficiency is
claimed. See [Execution modes](../concepts/execution-modes.md).

To enable `optimized` mode:

```bash
npm i -g @caveman-ai/cli
caveman start
```

## Multi-turn

```ts
import { createConversation, run } from "@caveman-ai/agent";

const conversation = createConversation();
await run(support, "My order is late.", { conversation });
const followUp = await run(support, "What should I do next?", { conversation });
```

One conversation is single-owner: concurrent use of the same conversation fails
closed, and a failed turn rolls conversation and cache state back.

## Streaming

```ts
import { stream } from "@caveman-ai/agent";

for await (const event of stream(support, "Where is order A-123?")) {
  if (event.type === "model_delta") process.stdout.write(event.text);
}
```

Typed run, context, model, completion, and error events. Calling the iterator's
`return()` aborts in-flight provider, tool, and subagent work before
conversation ownership releases. Both terminal events (`run_end`, `run_error`)
carry the ledger, and the promise entry points throw `CavemanRunError` whose
`receipt` holds the partial spend.

## Readiness check

```bash
npx caveman-agent doctor        # add --json for a machine-readable report
```

`doctor` makes no model request. Missing engine, runtime CLI, or gateway is a
`WARN` and exits 0. Bad Node version, broken sandbox containment, invalid
config, or lock drift fails.

## Next steps

- [Agent definitions](02-agent-definitions.md) — everything `agent()` accepts.
- [The agent directory](03-agent-directory.md) — the filesystem-first layout.
- [Tools](04-tools.md) — schemas, effects, and result policies.
- [Budgets, receipts, and breakers](09-budgets-receipts-breakers.md) — spend control.
