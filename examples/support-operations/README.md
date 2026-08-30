# Support Operations

Production-shaped customer-support service built on `@caveman-ai/agent`.

Service accepts tenant-scoped cases, loads one order and current regional
policy in application code, runs budgeted durable analysis, persists actual
run receipt, then records an immutable refund or specialist-handoff proposal.
Workflow stops there. Model and service cannot issue refund, change order,
contact customer, or execute proposal.

## What is real

- HTTP health/readiness and versioned workflow routes
- bearer principals mapped only to tenant and actor
- tenant-isolated order/case lookup and cross-tenant 404 behavior
- idempotent mutations, persistent state, durable model runs, immutable audit
- structured SDK output plus independent business-bound validation
- optimized-by-default server backed by current Pi Cave Build
- same-case off/on command using two actual provider executions

No fake provider or fabricated savings appears in live path. Deterministic tests
use Pi's shipped faux provider only and label that proof as fixture execution.

## Deterministic proof

From this directory:

```bash
npm --prefix ../../packages/agent run build
npm install --ignore-scripts
npm test
```

Tests start real HTTP listener and prove health, readiness, authentication,
tenant isolation, idempotency, SDK execution, refund bounds, immutable proposal
handoff, durable replay, audit records, persistence, malformed output, and
optimized-mode fail-closed startup. They make no network/provider call.

## Build optimization

Build uses reviewed profile, development, and untouched holdout fixtures from
`evals/support.eval.ts`. Compiler is pinned to
`anthropic/claude-haiku-4-5` so build and comparison use same model.

```bash
export ANTHROPIC_API_KEY=...
export CAVE_MODEL=anthropic/claude-haiku-4-5
npm run optimize
npm run check:optimization
```

`npm run optimize` performs real profile/search/holdout calls within declared
public-catalog search ceiling. It writes `.caveman/agent.lock.json` only when
quality and safety gates lock. Do not commit lock produced from unreviewed evals.

## Show optimization off versus on

Comparison requires current Cave Build, Caveman Engine/gateway, Caveman account
credential, and selected provider credential. It refuses missing lock, stale
runtime/catalog/adapter/registry identity, zero applied transforms, observe-only
optimized result, incomplete usage, unpriced model, recovery failure, or
different business disposition/refund amount.

```bash
export CAVE_API_KEY=...
export ANTHROPIC_API_KEY=...
# Optional when Engine is not on normal PATH/default endpoint:
export CAVEMAN_ENGINE_BIN=/absolute/path/to/caveman-engine
export CAVEMAN_PROXY_BIN=/absolute/path/to/caveman-proxy
export CAVE_GATEWAY_URL=http://127.0.0.1:8787
npm run compare -- --yes
```

`--yes` acknowledges at least two real provider calls. JSON output contains:

- off receipt: `mode: "observe-only"`, `unlocked: true`, no transforms
- on receipt: `mode: "optimized"`, `unlocked: false`, build digest, evaluated
  and applied transforms, zero transform failures, recovery success
- quality-equivalence result and descriptive token/list-price deltas
- `claimBasis: "inferred"` and `verifiedSavingsUsd: 0`

Positive delta remains local public-catalog estimate, never provider invoice or
verified savings.

## Run service

Optimized mode is default and requires `.caveman/agent.lock.json`. Configure
explicit tenant-scoped principals:

```bash
export CAVE_API_KEY=...
export ANTHROPIC_API_KEY=...
export SUPPORT_API_KEYS_JSON='[
  {"token":"replace-with-at-least-24-random-characters","tenantId":"northwind","actorId":"agent-1"}
]'
npm run build
npm start
```

For explicit direct-provider baseline service:

```bash
export SUPPORT_OPTIMIZATION_MODE=off
npm start
```

Optimized startup first runs `caveman-agent check` with explicit subprocess
environment allowlist, then loads `.caveman/agent.lock.json`. Stale source,
eval, config, runtime, adapter, catalog, or Engine registry blocks listener.
`SUPPORT_HOST`, `SUPPORT_PORT`, and `SUPPORT_DATA_FILE` override listener and state. Default listener is
`127.0.0.1:8789`.

Create case:

```bash
curl -sS http://127.0.0.1:8789/v1/cases \
  -H 'authorization: Bearer replace-with-at-least-24-random-characters' \
  -H 'content-type: application/json' \
  -H 'idempotency-key: create-case-0001' \
  --data '{"externalId":"desk-42","orderId":"NW-1042","subject":"Damaged delivery","body":"The shoulder strap arrived torn."}'
```

Use returned case ID with `POST /v1/cases/{id}/analyses` and `{}` body. Result
ends in `proposal_ready`. No route accepts, dispatches, or executes it.

## Security and data boundary

- Tokens never enter logs. Production deployment still needs gateway/identity
  provider, TLS, rate limits, rotation, and abuse controls.
- Application retrieves one tenant-scoped order and regional policy before
  model call. Agent has no data-selection or mutation tool.
- Customer text is marked untrusted. SDK output schema checks shape; domain
  layer checks allowed disposition, evidence, escalation, and money bounds.
- Refund/escalation output is evidence-only handoff data. No action integration
  or workflow transition exists after proposal recording.
- Durable journal and support state contain customer content. Files use private
  modes; apply production encryption, retention, deletion, and access controls.
- Explicit `sandbox: "required"` is containment for supported subprocess/tool
  paths. This agent owns no tools. Host sandbox would mean uncontained host
  execution and is not used here.

## Honest limits

Built-in file store is single-process and serializes writes only inside that
process. It is not transactional multi-replica database or distributed lock.
Replace with tenant-keyed transactional store before horizontal scaling.
Service does not supply TLS, SSO, key rotation, perimeter policy, queue worker,
or outbound helpdesk connector. Sample has no downstream-transition or execution subsystem
and never moves money.
