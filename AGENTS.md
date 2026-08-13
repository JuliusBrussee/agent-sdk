# Caveman Agent SDK

## Scope

Standalone TypeScript repository for `@caveman-ai/agent` and
`@caveman-ai/create-agent`.

## Non-negotiable contracts

- Savings stay `inferred`; never mint or imply verified savings locally.
- Unknown model, pricing, usage, grader, runtime, or sandbox state fails closed.
- Observe-only paths never claim optimization.
- Provider-visible cache prefixes stay byte-stable inside one cache epoch.
- Tool and subprocess environments use explicit allowlists, never ambient secret
  inheritance.
- Host sandbox means uncontained host execution. Never describe it as isolation.
- Generated `packages/agent/src/catalog.ts` changes only through
  `node scripts/generate-agent-catalog.mjs`.

## Checks

```bash
npm ci --prefix packages/agent
npm ci --prefix packages/create-caveman-agent
npm ci --prefix examples/coding-agent --ignore-scripts
npm test
npm run pack:check
```

On restricted hosts, rerun macOS `sandbox-exec` and loopback-dependent tests with
required permissions before classifying failures as product defects.
