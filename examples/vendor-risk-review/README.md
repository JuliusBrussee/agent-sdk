# Vendor Risk Review

Production-shaped third-party risk workflow. Reviewer submits tenant-scoped
questionnaire for known vendor. Application binds bounded evidence set. Agent
maps four controls from file-backed framework, drafts risk tier and onboarding
conditions, then records immutable evidence-only handoff. Workflow ends there.

```bash
npm --prefix ../../packages/agent run build
npm install --ignore-scripts
npm test
```

Deterministic tests use exact Pi faux provider. They prove HTTP/auth/tenant
isolation/idempotency, file context, structured control validation, unknown
evidence rejection boundary, durable receipt, missing execution route, audit,
and actual SDK memory isolation between tenants. Runtime config uses one-compaction
maximum under hard token cap and explicit local-only 90-day memory namespace.

Live:

```bash
export CAVE_MODEL=anthropic/claude-sonnet-4-6
export ANTHROPIC_API_KEY=...
export VENDOR_API_KEYS_JSON='[
  {"token":"replace-with-24-random-characters-1","tenantId":"northwind","actorId":"reviewer-1"}
]'
npm run build
npm start
```

Routes: `POST /v1/reviews`, `POST /v1/reviews/{id}/analysis`,
`GET /v1/reviews/{id}`, `GET /v1/audit`. No route accepts, rejects, procures,
onboards, or executes proposal.

Questionnaire/evidence are untrusted. Model can cite only whitelisted evidence
ids. Domain layer requires all controls exactly once, forbids favorable
disposition with a gap, requires conditions for `conditions_required`,
and blocks favorable disposition for critical risk. Model cannot procure,
contract, onboard, grant exception, or change vendor. Receipt is inferred only.

File store and local memory are single-host examples, not enterprise records
system. Add database transactions, object evidence store, malware scanning,
retention/deletion, SSO, rate limits, signatures, evidence provenance, policy
versioning, and outbound procurement integration before production.
