# Security

Report vulnerabilities privately through GitHub Security Advisories. Do not open
public issues containing exploit details or credentials.

## Runtime boundaries

- `sandbox: "required"` needs OS-backed containment and fails closed when that
  containment cannot be established.
- `sandbox: "fixture"` is deterministic test isolation, not production OS
  containment.
- `sandbox: "host"` executes with current user's host privileges. It is explicit
  unsafe-host mode, not sandboxing, and is ineligible for locked Cave Builds.
- Coding-agent `bash` is intentionally uncontained. Framework strips provider and
  Caveman credentials through fixed environment allowlists, but command still has
  user's filesystem/process privileges.
- Observe-only mode talks directly to selected provider and sends no Caveman
  gateway telemetry.

Detailed model: [packages/agent/SANDBOX_THREAT_MODEL.md](./packages/agent/SANDBOX_THREAT_MODEL.md).
