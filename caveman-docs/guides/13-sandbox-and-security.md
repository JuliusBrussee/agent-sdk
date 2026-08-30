# Sandbox and security

Read this before changing anything under `executeSandboxedTool`,
`networkIsolatedNode`, `installNetworkDeny`, or the `sandboxProfile` type. The
governing rule: **name the real boundary, and name every gap.** A sandbox that
claims more than it enforces is a correctness bug, not a documentation nit.

## The three modes

| Mode | What runs where | Is it a boundary? |
| --- | --- | --- |
| `required` (default) | Tool code runs in a **separate OS-isolated subprocess** | Yes — see below |
| `fixture` | Trusted test tools in the host process; `effect: "write"` and `"external"` are **blocked, not executed** | No. A convenience for trusted evals |
| `host` | Closures run **in-process with no isolation at all**; `effect: "write"` executes | No. Uncontained by design |

`host` is refused under a `required` ancestor
(`cave_host_sandbox_nested_under_required`), so a subagent cannot use it to
leave its root's containment. It also makes a build lock-ineligible
(`cave_host_sandbox_lock_ineligible`) — `compile` refuses host mode **anywhere**
in the definition graph, root or subagent, because a host subagent runs closures
in this process just as a host root does.

## The real boundary in `required` mode

`executeSandboxedTool` spawns the tool worker under **two independent kernel
mechanisms**:

### 1. OS network isolation (`networkIsolatedNode`)

| Platform | Mechanism | Result |
| --- | --- | --- |
| Linux | `unshare --user --map-root-user --net` | A fresh network namespace with no interfaces — no IP egress (TCP/UDP/DNS) |
| macOS | `sandbox-exec -p '(version 1)(allow default)(deny network*)'` | Kernel denial of network operations |
| Anything else | — | `cave_sandbox_os_network_isolation_unavailable`; the tool cannot run at all |

### 2. The Node permission model

`--permission` plus `--allow-fs-read` / `--allow-fs-write`:

- Reads restricted to the staged source graph, the framework package root, the
  dependency closure, and an ephemeral workspace.
- Writes restricted to that workspace.
- `child_process` denied entirely
  (`cave_sandbox_child_process_containment_unavailable`).

`verifySandboxConformance()` (and the `sandbox_passed` build evidence) spawns a
probe under mechanism 1 and asserts home-read denial, child-process denial, and
network/DNS/UDP denial. The probe runs under the real boundary, so a pass
reflects the kernel boundary rather than the in-process layer.

## `installNetworkDeny` is defense-in-depth, never a boundary

It monkeypatches `globalThis.fetch`, `WebSocket`, and the module-level
`connect`/`request`/`lookup` exports of `node:http|https|net|…`. It is bypassable
by design of the JS runtime:

- `new net.Socket().connect(...)` never touches the patched module export.
- A fresh `import`/`createRequire` of a core module returns unpatched bindings.
- `node:dns/promises` is a different module object than the patched `node:dns`.
- `new http.ClientRequest(...)` bypasses the patched `http.request`.

It stays only as a redundant second layer inside a worker that already runs under
the kernel boundary. The attack tests deliberately include a `tcp_connect`
vector (`net.Socket`) whose block therefore proves the OS boundary, not the
patch.

## Known gaps — tracked, not silently accepted

| Gap | Detail |
| --- | --- |
| **Linux unix-domain sockets** | A network namespace does not cover `AF_UNIX`. A tool that can see a host unix socket path (for example `/var/run/docker.sock`) can still connect to it, and the Node permission model does not gate `AF_UNIX` connect. Closing this needs a mount namespace (bwrap / `unshare --mount`). Until then, `required` mode does not contain unix-socket egress on Linux |
| **Scoped network egress** | `sandboxProfile.network: true` is **not** a way to allow egress. It requests unbounded egress and fails closed with `cave_sandbox_network_egress_unbounded`. Real scoped egress needs a parent-owned CONNECT proxy bound to an allow-list |
| **`child_process`** | Fails closed until portable, verifiable descendant containment exists |
| **Non-Linux/macOS** | No OS isolation available; tools fail closed |
| **Native Windows** | `required` fails closed — no verified OS network-isolation boundary there. `doctor` reports `cave_sandbox_os_network_isolation_unavailable` and names WSL2 as the remedy. Ordinary runs, runtime/engine startup, and explicit `sandbox: "host"` tools through `cmd.exe` do work |

Never replace a required sandbox with fixture mode in production.

## Credentials

A live sandbox profile may request exactly **one** runtime-owned provider
capability:

- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
- the Google capability (`GEMINI_API_KEY` and `GOOGLE_API_KEY` are aliases)

Signing, deployment, bootstrap, database, cloud, loader, and ambient environment
names are **categorically denied**. The child starts from a fixed baseline
(`LANG`, `LC_ALL`, `PATH`, `TZ`, and the fixture marker) rather than a spread of
the parent environment. Relevant refusals:
`cave_sandbox_credential_env_not_allowlisted`,
`cave_sandbox_credential_capability_ambiguous`,
`cave_sandbox_credential_missing`.

Combined with the kernel network boundary, a leaked key cannot be exfiltrated
over IP from `required` mode — subject to the Linux unix-socket gap above.

## The staged source graph

Before any provider traffic, a `required` run copies the **complete project
source graph** into a per-run immutable staging directory, imports tool workers
only from that snapshot, and tears staging down when the stream settles. Running
such tools in-process is refused.

The graph resolver is strict: it uses `es-module-lexer` for ESM plus
comment-aware scanners for TypeScript type edges, `require`, and
`new URL(..., import.meta.url)`; it follows dependency edges from physical
package roots so pnpm symlink layouts lock the same reachable artifacts as npm;
and it **rejects computed project loaders**. A computed import like
`` new URL(`../tickets/${name}.md`) `` is unlockable and fails the build.

Root `node_modules` is never readable as a whole: required-sandbox workers
enumerate core's exact installed dependency closure and grant those package
roots individually.

## Subagents under containment

Framework subagents may use normal tools and delegate further subagents. The CLI
passes one root entry automatically; programmatic runs pass `entryPath` once at
the root. The framework keeps the descendant route private, verifies root and
selected-tool definition digests after sandbox re-import, then executes the
exact child tool in a restricted subprocess. Required-sandbox policy propagates
down the whole graph.

## The coding agent's `bash` is uncontained by design

It runs arbitrary host commands with the user's privileges. Two mitigations that
are real, and no claim beyond them:

- Its subprocess environment is a fixed shell/locale allow-list, **not** a spread
  of `process.env`, so a model-driven command cannot read `CAVE_API_KEY`,
  `ANTHROPIC_API_KEY`, or any other framework credential and exfiltrate it.
- Tool containment is realpath-based: a symlink out of the workspace is out.
- `bash` runs its command in its own process group, so a timeout kills the tree
  instead of waiting on a backgrounded child's inherited stdout.

## Checking your machine

```bash
caveman-agent doctor          # includes the containment probe
```

```ts
import { verifySandboxConformance } from "@caveman-ai/agent";
await verifySandboxConformance();
```

Canonical threat model:
[`packages/agent/SANDBOX_THREAT_MODEL.md`](../../packages/agent/SANDBOX_THREAT_MODEL.md).
