# Runnable examples

Examples are acceptance products for SDK contracts. Each owns setup, tests,
runtime entrypoint, threat boundary, and honest live-provider gate.

- `coding-agent`: interactive host coding agent. Existing compatibility sample;
  host execution is not isolation.
- `support-operations`: implemented enterprise support proposal handoff with
  deterministic HTTP proof.
- `security-incident-triage`: implemented evidence-only incident containment handoff.
- `vendor-risk-review`: implemented evidence-only vendor risk handoff.
- `adapters/*`: exact-pinned runnable lanes for Pi, Claude Agent SDK, Vercel AI
  SDK, Eve, and Mastra. Planned.

README presence is not proof; root `npm run test:example` executes every sample
package.
