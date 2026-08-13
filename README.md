# Caveman Agent SDK

Standalone home for [`@caveman-ai/agent`](./packages/agent) and
[`@caveman-ai/create-agent`](./packages/create-caveman-agent).

Agent SDK provides TypeScript agent runtime, tools, subagents, conversations,
provider selection, usage accounting, sandbox policy, Context IR, profile-guided
compilation, eval-gated immutable Cave Builds, and exact-pinned adapters for Pi,
Claude Agent SDK, Vercel AI SDK, Eve, and Mastra.

## Start

```bash
npm create @caveman-ai/agent@latest my-agent
cd my-agent
npm run doctor
npm run dev
```

Or install framework directly:

```bash
npm install @caveman-ai/agent
```

Full API and safety contract: [packages/agent/README.md](./packages/agent/README.md).

## Develop

Requires Node.js 22.19+.

```bash
npm ci --prefix packages/agent
npm ci --prefix packages/create-caveman-agent
npm ci --prefix examples/coding-agent --ignore-scripts
npm test
npm run pack:check
```

`npm test` checks generated provider catalog, type contracts, 365 runtime tests,
10 compiler-replay tests, deterministic replay artifact, and initializer suite.
macOS restricted-tool tests require working `sandbox-exec` and loopback access.

## Honesty boundary

Local execution and replay evidence remain `inferred`. Agent SDK does not publish
a savings percentage. `verifiedSavingsUsd` remains `0` until active real traffic
passes Caveman Cloud rollout and ledger gates. Unknown price/model/runtime state
fails closed or returns honest zero; it is never guessed.

## Packages

- `packages/agent` — `@caveman-ai/agent` v0.2 compiler/runtime.
- `packages/create-caveman-agent` — zero-runtime-dependency project initializer.
- `packages/shared` — pinned wire schemas and provider-catalog snapshot required
  to regenerate and verify Agent SDK artifacts.
- `internal/agentbench/corpus` — pinned Apache-2.0 evaluation subset used only by
  deterministic compiler replay.

## License

MIT. Anthropic Claude Agent SDK dependency remains governed by Anthropic terms;
see framework README and sandbox threat model for exact boundary.
