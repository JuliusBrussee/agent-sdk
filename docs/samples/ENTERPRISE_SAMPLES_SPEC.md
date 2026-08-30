# Enterprise sample projects specification

Status: active implementation contract

## Goal

Prove `@caveman-ai/agent` and every shipped adapter through production-shaped,
runnable workflows. Samples are product evidence, not screenshots or API
snippets. Each project must remain useful as a small standalone service while
staying small enough to audit.

## Non-goals

- No fake provider success, fabricated savings, or implied adapter
  certification.
- No real payment, deployment, containment, account, ticket, procurement, or
  customer mutation. Standalone workflows terminate after immutable proposal
  handoff and expose no downstream action endpoint.
- No shared SaaS platform, database framework, frontend framework, or hosted
  Caveman dependency hidden behind examples.
- No proprietary Pebble implementation.

## Sample portfolio

### Standalone enterprise applications

| Project | Workflow | SDK proof |
| --- | --- | --- |
| `support-operations` | Ingest customer case, retrieve order and policy evidence, record response/refund/specialist proposal, stop | directory agent, skills, sandboxed read tools, structured output, budgets, receipts, durable runs |
| `security-incident-triage` | Ingest alert bundle, correlate asset and control evidence, record severity and containment proposal, stop | typed tools, subagents, stream events, deadlines, partial receipts, aborts |
| `vendor-risk-review` | Review vendor questionnaire and evidence, map controls, record gaps and risk conditions, stop | memory isolation, compaction, eval splits, file context, auditable evidence citations |

### Exact adapter lanes

| Adapter | Pinned upstream | Executable proof |
| --- | --- | --- |
| Pi | `@earendil-works/pi-agent-core@0.83.0` | native compile target plus locked execution request |
| Claude Agent SDK | `@anthropic-ai/claude-agent-sdk@0.3.220` | unlocked `runClaudeAgent` workflow with declared read-only tools and explicit caps |
| Vercel AI SDK | `ai@7.0.43` | real `ToolLoopAgent.generate` binding passed through Caveman evidence adapter |
| Eve | `eve@0.29.2` | real `ClientSession.send().result()` binding with durable event usage parsing |
| Mastra | `@mastra/core@1.55.0` | real `Agent.generate` binding with retry suppression and explicit `maxSteps` |

Adapter capabilities remain whatever package manifests declare. Runnable sample
does not promote `experimental` to `certified`; only conformance report evidence
can do that.

## Required application contract

Every standalone project must provide:

1. `README.md` with exact setup, live-provider prerequisites, demo path, threat
   boundary, data model, and honest limitations.
2. `.env.example` containing names only. No credentials or secret-shaped demo
   values.
3. `package.json` with `dev`, `start`, `typecheck`, and `test` commands.
4. HTTP service with `/healthz`, `/readyz`, versioned workflow endpoints,
   bounded request bodies, structured errors, graceful shutdown, and JSON logs.
5. Tenant-scoped storage. Caller supplies authenticated tenant and actor;
   cross-tenant reads and writes fail closed. Samples expose no per-actor action
   filtering, delegation token, or action-entitlement layer.
6. Idempotency keys on mutations and immutable audit records for every state
   transition.
7. Agent output is immutable proposal/handoff evidence. Service persists it and
   stops. No queue, accept/reject transition, action dispatch, external write,
   monetary/security/deployment/account operation, or downstream review subsystem
   exists in these samples.
8. Explicit model-call, tool-call, deadline, and token or catalog-USD budget.
   Receipts persist beside workflow state. Local savings remain `inferred` and
   `verifiedSavingsUsd` remains `0`.
9. Deterministic no-network integration tests using SDK-supported provider test
   seams. Tests must exercise HTTP, authentication, tenant isolation,
   idempotency, immutable audit, missing action routes, malformed output, abort,
   and fail-closed paths.
10. Optional live smoke command. It must use installed upstream package and a
    real provider transport, skip with a clear reason when credential is absent,
    and never be counted by default tests as live certification.

Flagship support sample additionally needs one same-case comparison command:

- `off` executes direct provider observe-only path;
- `on` executes current, validated Cave Build and must return `mode:
  "optimized"`, `unlocked: false`, non-empty evaluated transform evidence, and
  successful recovery evidence;
- comparison records both actual provider receipts and quality result. It never
  treats two non-equivalent drafts as savings evidence;
- measured token and public-catalog cost deltas stay descriptive and
  `inferred`; `verifiedSavingsUsd` remains `0`;
- missing Engine, gateway, credential, current lock, or transform application
  fails `on` explicitly. No silent observe-only result appears in optimized
  column;
- command warns before spending twice.

## Required adapter contract

Each lane must:

- install local Caveman packages plus exact peer version from package manifest;
- import upstream runtime from its public package export, not a hand-written
  lookalike module;
- assert installed upstream version before provider traffic;
- expose complete identity digests from actual packaged bytes and lockfile;
- pass a framework-native object into Caveman adapter;
- run deterministic contract tests against exact framework method/event shapes;
- include credential-gated live smoke where upstream supports it;
- assert terminal identity, provider/model, complete usage, abort behavior,
  receipt basis, `claimBasis: "inferred"`, and `verifiedSavingsUsd: 0`;
- document unsupported behavior and never call experimental capability
  certified.

## Shared proof gates

Completion requires all following evidence:

- all sample typechecks and deterministic tests pass from clean installs;
- sample service starts, answers health/readiness, executes one full workflow,
  survives duplicate mutation, refuses cross-tenant access, and shuts down;
- every adapter lane loads exact pinned upstream and reaches its real binding;
- credential-present live smokes pass, or credential absence is reported as an
  explicit unrun gate;
- `npm test`, `npm run license:check`, and `npm run pack:check` pass;
- cold temporary consumer installs packed archives and runs sample smoke;
- issue ledger contains each discovered SDK or sample defect, root cause, fix,
  regression proof, and remaining limits.

## Implementation order

1. Sample harness and `support-operations` vertical slice.
2. Adapter workbench primitives and Vercel lane, because its public binding is
   smallest and already covered by core runtime tests.
3. Mastra, Eve, Claude, and Pi lanes.
4. Security triage and vendor risk applications.
5. Cold-install, full-gate, and credential-gated live proof.
