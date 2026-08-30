# Runnable examples

Examples are acceptance products for SDK contracts. Each owns setup, tests,
runtime entrypoint, threat boundary, and honest live-provider gate.

- `coding-agent`: interactive host coding agent. Existing compatibility sample;
  host execution is not isolation.
- `support-operations`: implemented enterprise support proposal handoff with
  deterministic HTTP proof; contract in `docs/samples/ENTERPRISE_SAMPLES_SPEC.md`.
- `security-incident-triage`: implemented evidence-only incident containment handoff.
- `vendor-risk-review`: implemented evidence-only vendor risk handoff.
- `adapters/*`: exact-pinned runnable lanes for Pi, Claude Agent SDK, Vercel AI
  SDK, Eve, and Mastra. Planned.

Current implementation status and defects live in
`docs/samples/ISSUES.md`. README presence is not proof; root sample gates must
execute every package before portfolio is called complete.
