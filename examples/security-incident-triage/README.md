# Security Incident Triage

Small incident-response control plane built on `@caveman-ai/agent`. It accepts
tenant-scoped SIEM alerts, binds one known asset, runs control lookup plus
independent blast-radius subagent, streams triage evidence, and records immutable
containment handoff. Model and service never execute containment.

## Proof

```bash
npm --prefix ../../packages/agent run build
npm install --ignore-scripts
npm test
```

Tests use exact Pi faux provider and real SDK tool/subagent/stream paths without
network. They prove HTTP health/readiness, auth, tenant isolation, idempotency,
typed control tool, capped subagent, durable receipt, stream terminal, immutable
proposal persistence, missing execution route, audit, and pre-abort zero-provider behavior.

## Run live

```bash
export CAVE_MODEL=anthropic/claude-sonnet-4-6
export ANTHROPIC_API_KEY=...
export SECURITY_API_KEYS_JSON='[
  {"token":"replace-with-24-random-characters-1","tenantId":"northwind","actorId":"responder-1"}
]'
npm run build
npm start
```

Routes: `POST /v1/incidents`, `POST /v1/incidents/{id}/triage`,
`GET /v1/incidents/{id}`, and `GET /v1/audit`. Mutations require idempotency
key. No route dispatches or executes containment.

Security boundary: alert text is untrusted; asset selection occurs in
tenant-scoped application store; tool exposes reviewed control catalog only;
subagent has one call and no tools; root has token/call/tool/deadline/concurrency
caps. Proposal passes SDK schema then business severity/evidence checks.
Receipt stays `claimBasis: "inferred"`.

Built-in store is private-mode single-process file state, not multi-replica
database. Service omits TLS, SSO, rate limits, SIEM connector, paging, evidence
retention policy, and actual EDR/IAM/WAF execution. Production system must add
those controls in a separate downstream system. This sample exports evidence;
it owns no action or downstream transition workflow.
