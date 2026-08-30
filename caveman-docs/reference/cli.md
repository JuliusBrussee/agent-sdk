# CLI reference

Two binaries ship from this repository:

| Binary | Package | Purpose |
| --- | --- | --- |
| `caveman-agent` | `@caveman-ai/agent` | Develop, build, check, diagnose, serve, register, connect |
| `caveman-code` | `@caveman-ai/coding-agent` | The interactive coding agent |
| `create-caveman-agent` | `@caveman-ai/create-agent` | Project scaffold (`npm create @caveman-ai/agent@latest`) |

---

## `caveman-agent`

```text
Caveman Agent — efficiency-native TypeScript agent framework

Usage:
caveman-agent dev [entry] [prompt]
caveman-agent serve [dir] [--port N] [--host H] [--locked]
caveman-agent build [config] [--verbose] [--accept-prefix-shrink]
caveman-agent check [config]
caveman-agent doctor [--json]
caveman-agent register
caveman-agent connect [provider|providers|connections|status|doctor|...]
caveman-agent --version
```

`--help` / `-h` prints the block above. `--version` / `-v` prints the framework
version. An unknown command throws and names `--help`.

### `dev [entry] [prompt]`

Interactive development loop with hot reload.

- **Entry resolution.** With no `entry`, `dev` prefers the agent-directory
  convention when `instructions.md` exists at the project root; otherwise it
  uses `src/agent.ts`. An explicit entry may also name a convention directory,
  which maps to its generated module entry.
- **Interactive vs one-shot.** Interactive when no prompt was given and both
  stdin and stdout are TTYs. Otherwise it runs one turn with the prompt (default:
  `"Reply with one short greeting."`).
- **Snapshots.** One immutable staged copy of the complete project-relative
  source graph is reused until watched project source, config, eval, or file
  context changes. The prompt then becomes `caveman-agent (reloaded)>` and the
  next turn replaces the snapshot; successful conversation history stays local to
  the parent process.
- **Watch exclusions.** `node_modules`, `.git`, `dist`, `coverage`, `.turbo`, and
  `.caveman/runs` (the receipt trail each turn writes).
- **Directory entry regeneration.** `.caveman/agent-dir-entry.mjs` is regenerated
  by pure directory scan before every staging pass, so a tool added or removed
  mid-session lands in the staged graph. User modules are only ever imported
  inside the staged snapshot.
- Each turn prints its receipt.

Node ESM cannot tear down timers or listeners created by an old module graph
after hot reload. Keep the agent module's top level side-effect-free, or restart
`dev` after editing a module that owns process resources.

### `build [config] [--verbose] [--accept-prefix-shrink]`

Runs the static plan checks, then the declared evals within the configured search
budget, then writes the lock on success.

| Flag | Effect |
| --- | --- |
| `--verbose` | Shows wire failure codes alongside the plain-language failure |
| `--accept-prefix-shrink` | Resets the frozen-prefix baseline. If the build then stops before locking (for example `needs_eval`), **no new baseline is written** until a build completes |

`config` defaults to `caveman.config.ts`. See [Evals and Cave Build](../guides/12-evals-and-build.md).

### `check [config]`

Validates lock identity and project freshness. Rejects drift **before any model
call**. This is the deployment/startup gate — parsing a lock alone does not
establish freshness.

### `doctor [--json]`

Zero-spend readiness report. Makes no model request.

Checks: Node version, sandbox containment probe, Caveman engine registry, runtime
CLI, gateway reachability, project and config load, Context IR, lock drift,
provider selection, and per-harness locked-execution readiness. It also detects a
`vercel/eve` agent directory (nested `agent/` layout, or a flat layout with
eve-only `channels/`, `schedules/`, `connections/`, `hooks/`; suppressed when
`caveman.config.ts` exists) and prints the migration mapping.

| Status | Meaning | Exit |
| --- | --- | --- |
| `PASS` | Fine | 0 |
| `WARN` | Missing engine, runtime CLI, or gateway — observe-only runs still work | 0 |
| `FAIL` | Bad Node version, broken sandbox containment, invalid config, lock drift | non-zero |

`--json` emits a machine-readable `DoctorReport` (`schema_version: 1`,
`framework_version`, `ready`, `execution_mode`, `checks[]`, `next_action`).

Human output prints `verified savings: $0`.

The Caveman public CLI version probe is `caveman version`, not `--version`.

### `serve [dir] [--port N] [--host H] [--locked]`

See [Serving and hosting](../guides/11-serving-and-hosting.md).

| Argument | Default |
| --- | --- |
| `dir` | `.` |
| `--port` | `PORT`, else `8080` |
| `--host` | `HOST`, else `0.0.0.0` |
| `--locked` | off — when set, every run executes through `.caveman/agent.lock.json` |

Requires `CAVE_SERVE_TOKEN`. `CAVE_JOURNAL_URL` requires `CAVE_JOURNAL_TOKEN`.

### `register`

Registers a locked build with a Caveman control plane.

Requires all three of `CAVE_CONTROL_URL`, `CAVE_TOKEN` (or `CAVE_API_TOKEN`), and
`CAVE_PROJECT_ID`. Refuses with `cave_stale_lock:registration` when the on-disk
lock does not match a freshly validated lock identity.

Posts to `{CAVE_CONTROL_URL}/api/v1/projects/{CAVE_PROJECT_ID}/agent-builds` with
the lock's agent slug and its build, plan, source, eval-suite, catalog, and
transform-registry digests plus harness and adapter versions. Registration is
client-declared inspection, not attestation; verified savings stay `$0`.

### `connect [...]`

Delegates to the external `cave-connectd` binary. Recognized subcommands pass
through verbatim; anything else is treated as a provider name, so
`caveman-agent connect github` becomes `connect github`.

```text
serve  start  stop  connect  providers  connections  disconnect
open   status doctor audit   agent      secret       mcp        version
```

The child receives an explicit non-secret environment allowlist; provider keys
and `CAVE_CONNECT_SECRET_KEY` are stripped. Binary resolution uses an absolute
`CAVE_CONNECT_BIN` or an executable found on `PATH`, then resolves and validates
the real file. The exit code is the child's.

See [Caveman Connect](../guides/14-connect.md).

---

## `caveman-code`

```text
Usage: caveman-code [options]

Options:
  --workspace <path>    workspace root (default: current directory)
  --model <id>          provider/model override
  --observe-only        disable Cave runtime transforms
  --max-cost-usd <usd>  best-effort per-turn public-catalog spend cap
  --no-start-runtime    probe runtime without trying to start it
  -h, --help            show help
```

An unknown option, a missing value, or a non-positive `--max-cost-usd` throws
before anything starts.

In-session commands: `/help`, `/mode`, `/tokens`, `/prove-recovery`, `/exit`,
`/quit`.

See [The coding agent](../guides/18-coding-agent.md).

---

## `create-caveman-agent`

```bash
npm create @caveman-ai/agent@latest my-agent
npm create @caveman-ai/agent@latest my-agent -- --provider anthropic
npm create @caveman-ai/agent@latest my-agent -- --provider openai --no-install
```

| Flag | Effect |
| --- | --- |
| `--provider <anthropic\|openai\|google>` | Non-interactive provider choice |
| `--no-install` | Skip dependency installation |

Exactly one detected credential is selected silently; zero or several prompt
once. Secrets are never printed or written. The scaffold's own scripts are
`npm run doctor`, `npm run dev`, `npm run build`, `npm run check`.

---

## Repository scripts

Run from the repository root.

| Command | What it does |
| --- | --- |
| `npm test` | License lint, catalog drift, protocol, evals, adapter-kit, adapter conformance, coding agent, package types, agent runtime, adapters, conformance-candidate reproduction, initializer, example |
| `npm run build` | Builds `pebble-protocol`, `evals`, `agent`, `create-caveman-agent` |
| `npm run license:check` | Licensing lint |
| `npm run pack:check` | Packability of every publishable package |
| `npm run check:catalog` | Fails when `src/catalog.ts` drifts from the catalog snapshot |
| `node scripts/generate-agent-catalog.mjs` | The **only** supported way to change `packages/agent/src/catalog.ts` |
| `node scripts/generate-docs-api.mjs` | Regenerates `caveman-docs/reference/api/**` and `reference/identifiers.md` |
| `node scripts/typecheck-packages.mjs` | Per-package type checks |
| `npm run test:agent` / `test:protocol` / `test:adapters` / … | Narrower suites; see root `package.json` |

On restricted macOS hosts, rerun `sandbox-exec` and loopback-dependent tests with
the required permissions before classifying failures as product defects.
