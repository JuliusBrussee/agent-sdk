# Caveman Agent SDK

## Scope

Standalone TypeScript repository for `@caveman-ai/agent` and
`@caveman-ai/create-agent`.

Repository is private during development. Planned destination is public release
after licensing, history, packaging, test, and publication gates pass.
Caveman-Cloud remains private commercial source.
Proprietary Pebble implementation lives in sibling `caveman-coding-agent` and
must never land here. Only Apache-2.0 protocol remains in this repository.

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
- Canonical GitHub repository is `JuliusBrussee/agent-sdk`.
- Optional Agent Skills, AGENTS.md, and Agent Plugins compatibility lives once
  in `packages/agent/src/agent-environment.ts`. Core runtime never discovers
  workspace files automatically. Product wrappers may add search roots, but
  must not fork validation, containment, precedence, or invocation.
- Agent Plugins v1 and OpenPlugin support is declarative-only: skills and
  markdown slash commands. Recognize MCP, hooks, and custom agents, but never
  execute them. Executable integrations stay host-owned and require separate
  environment-allowlist and lifecycle contracts.

## Checks

```bash
npm ci
npm --prefix packages/pebble-protocol run build
npm ci --prefix examples/coding-agent --ignore-scripts
npm test
npm run license:check
npm run pack:check
```

On restricted hosts, rerun macOS `sandbox-exec` and loopback-dependent tests with
required permissions before classifying failures as product defects.
