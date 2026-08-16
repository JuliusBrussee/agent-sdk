# Source snapshot

Initial standalone repository assembled 2026-08-13 from three local sources:

- `Caveman-Cloud` at `f4227620b5398483447419987ec048fcf10b37d9`, plus
  current Agent SDK/catalog worktree bytes — canonical v0.2 compiler/runtime,
  initializer, provider-catalog integration, contracts, and replay corpus.
- public `caveman` at `613d7f0402fb51bdde0edb6b01853b391a06b765`,
  plus current `packages/agent/src/runtime.ts` worktree byte — newer Windows
  command resolution and detached-process behavior merged into v0.2.
- `caveman-2` at `b3c50c3881c1cc2a1b1ff9bf5896258d3a887533` —
  compared; no unique newer Agent SDK implementation retained.

Source repositories remain untouched. This repository becomes standalone Agent
SDK development surface; future changes should land here first, then be mirrored
out deliberately.

## 2026-08-16 v2 sync

Second tree snapshot from `Caveman-Cloud` master at `0cee35ed` (Agent SDK v2:
convention loader, TS cache planner, skills, durable execution on an own
journal substrate, receipts/doctor polish). Synced `public/agent` →
`packages/agent`, `public/create-caveman-agent` → `packages/create-caveman-agent`,
`public/evals/src` → `packages/evals/src`, plus the vendored provider-catalog
snapshot, four wire schemas, and the catalog generator. `catalog.ts` regenerated
in-repo; repository URLs (package.json + tests) stay pinned to
`caveman-agent-sdk`; replay provenance path stays on the `packages/agent`
layout. Full suite green after sync: 507 runtime + 10 replay + 11 initializer +
2 example tests.
