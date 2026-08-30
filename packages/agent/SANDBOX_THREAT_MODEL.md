# @caveman-ai/agent — tool sandbox threat model

What the tool sandbox does and does **not** contain, per platform, and where the
real boundaries are. Read this before changing anything under
`executeSandboxedTool`, `src/sandbox/*`, `installNetworkDeny`, or the
`sandboxProfile` type. The honesty rule that governs this file: **name the real
boundary, and name every gap** — a sandbox that claims more than it enforces is
a correctness bug, not a doc nit.

## Modes

- `fixture` — trusted test tools; effects (`effect: "write"`/`"external"`) are
  blocked, not executed. Not a security boundary against hostile code; a
  convenience for trusted evals.
- `required` — untrusted tool code runs in a **separate OS-isolated subprocess**
  (`executeSandboxedTool`). This is the mode the boundaries below describe.
- `host` — explicit opt-in for interactive/coding agents; closures run
  **in-process with no isolation at all** and `effect: "write"` executes. Host
  mode is uncontained by design (documented as such), is refused under a
  `required` ancestor (`cave_host_sandbox_nested_under_required`), and makes a
  build lock-ineligible (`cave_host_sandbox_lock_ineligible`).

## The real boundary (`required` mode)

`executeSandboxedTool` picks a **containment backend** (`src/sandbox/backend.ts`),
which declares what it can and cannot enforce. The selector returns the
strongest available backend that satisfies the request and refuses otherwise; it
never downgrades silently.

| Backend | Platform | Mechanism | AF_UNIX contained | Scoped egress |
|---|---|---|---|---|
| `bubblewrap` | Linux, `bwrap` present | mount + net + pid + user namespaces | yes | yes |
| `seatbelt` | macOS | `sandbox-exec`, `(deny network*)` | yes | yes |
| `unshare` | Linux, no `bwrap` | `unshare --user --map-root-user --net` | **no** | no |

On top of the backend, every tool runs under the **Node permission model**
(`--permission` + `--allow-fs-read`/`--allow-fs-write`): reads restricted to the
staged source graph, framework package root, dependency closure, and an
ephemeral workspace; writes to the workspace only. `child_process` is denied
entirely (`cave_sandbox_child_process_containment_unavailable`). The permission
model supplies read *granularity* the namespace cannot; the namespace supplies
containment the permission model has no concept of.

`sandbox_passed` / `verifySandboxConformance` spawns a probe under the selected
backend and asserts home-read denial, child-process denial, and network/DNS/UDP
denial. It accepts either `ERR_ACCESS_DENIED` (permission model refused) or
`ENOENT` (mount namespace never showed the file); the parent creates the file
immediately before spawning, so `ENOENT` can only mean the namespace hid it.

## Scoped network egress

`sandboxProfile.network` takes three values:

- `false` — no network. The kernel removes every route out.
- a `SandboxEgressPolicy` — **scoped egress**. Allowed.
- `true` — unbounded egress. Still refused
  (`cave_sandbox_network_egress_unbounded`). Tool code holding a provider
  credential does not get an unfiltered socket; name the hosts instead.

Scoped egress is the architecture every serious agent sandbox converged on: the
contained process keeps **no network stack of its own**, and its single reachable
peer is a proxy the parent owns.

```
tool worker  ──▶  loopback :8118  ──▶  /run/cave-egress.sock  ──▶  egress proxy  ──▶  origin
(no route out)    (private netns)      (bound in by bwrap)         (parent process,
                                                                    holds the allowlist)
```

On macOS there is no mount namespace, so the Seatbelt profile re-allows loopback
and the child reaches the proxy's port directly — no bridge.

The child is configured with `NODE_USE_ENV_PROXY=1` plus `HTTP_PROXY`/
`HTTPS_PROXY`/`NO_PROXY` (Node ≥22.21 honours these for `fetch` and for
`node:http(s)`), so every HTTP client in the process routes through the
allowlist with no patching. The bridge in `sandbox/egress-client.ts` is
**plumbing, not a boundary** — a tool that tears it down or dials the socket
directly gains nothing, because the parent proxy is the enforcement point and
the kernel has already removed every other route.

Policy matching (`src/sandbox/policy.ts`) is strict on purpose. The known
real-world break in this class of allowlist was a *parsing* bug (a SOCKS5
hostname with a NUL byte matched `*.example.com` by string suffix while the
resolver used only the prefix). So hostnames are matched label-wise, never by
string suffix; any byte outside LDH rejects the host before matching; `*.` is
the only wildcard, only leading, and never matches the apex; and the port is
part of the decision.

**What scoped egress does not do:** the proxy tunnels `CONNECT` byte-for-byte
and never terminates TLS. It constrains the destination the client names, not
the payload — domain fronting defeats it. Terminating TLS would mean minting a
CA the tool trusts, which trades one risk for a worse one. Denials are counted
and surface on a failing tool as `:egress_denied=<n>`; hostnames are never put
in the error, because they are tool-controlled input.

## `installNetworkDeny` is DEFENSE-IN-DEPTH, not a boundary

`installNetworkDeny` monkeypatches `globalThis.fetch`, `WebSocket`, and the
module-level `connect`/`request`/`lookup` exports of `node:http|https|net|...`.
It is bypassable by design of the JS runtime and **must never be relied on as a
boundary**:

- `new net.Socket().connect(...)` never touches the patched module export.
- A fresh `import`/`createRequire` of a core module returns unpatched bindings.
- `node:dns/promises` is a different module object than the patched `node:dns`.
- `new http.ClientRequest(...)` bypasses the patched `http.request`.

It stays only as a redundant second layer inside the worker, which already runs
under the kernel boundary. The attack tests deliberately include a `tcp_connect`
vector (`net.Socket`) whose block therefore proves the OS boundary, not the
patch.

## Known gaps (tracked, not silently accepted)

- **Linux without bubblewrap** — the `unshare` backend has no mount namespace,
  so a tool that can see a host unix socket path (e.g. `/var/run/docker.sock`)
  can still `connect` to it, and the Node permission model does not gate
  `AF_UNIX` connect. Installing `bwrap` closes this. Scoped egress is refused
  outright on this backend (`cave_sandbox_scoped_egress_unavailable`) rather
  than served over a weaker boundary.
- **No TLS interception** — see above. Destination-level, not payload-level.
- **`child_process`** — fails closed
  (`cave_sandbox_child_process_containment_unavailable`) until portable,
  verifiable descendant containment exists.
- **Non-Linux/macOS** — no OS isolation available; tools fail closed.
- **Shared kernel** — none of these backends is a VM. A kernel vulnerability
  could enable escape. Deployments that need kernel-level isolation should run
  the whole agent inside gVisor or a microVM; this sandbox is the inner layer,
  not the only one.

## Credentials

A live profile may receive exactly one provider credential family
(`SANDBOX_CREDENTIAL_ENV_BY_CAPABILITY`); everything else is stripped, and the
child starts from a fixed baseline env, not a spread of the parent's. Combined
with the kernel network boundary, a leaked key cannot be exfiltrated over IP
from `required` mode — subject to the unix-socket gap above on Linux.
