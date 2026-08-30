# Environment variables

Everything the runtime, CLI, sandbox, server, and Connect client read from the
environment. Nothing here is inherited ambiently into a tool or subprocess —
every child environment is built from an explicit allowlist.

## Provider credentials

| Variable | Read by |
| --- | --- |
| `ANTHROPIC_API_KEY` | Provider selection, `auto()` resolution, sandbox credential grant |
| `OPENAI_API_KEY` | Same |
| `GEMINI_API_KEY` | Same — an alias of the Google capability |
| `GOOGLE_API_KEY` | Same — an alias of the Google capability |
| `ANTHROPIC_CUSTOM_HEADERS` | Claude lane header pass-through |

A live sandbox profile may request exactly **one** of these capability families.
Signing, deployment, bootstrap, database, cloud, and loader names are
categorically denied. See [Sandbox and security](../guides/13-sandbox-and-security.md).

## Model and project

| Variable | Default | Meaning |
| --- | --- | --- |
| `CAVE_MODEL` | unset | First step of `auto()` resolution: `"provider/model"` |
| `CAVEMAN_HOME` | `~/.caveman` | Local Caveman home |
| `CAVE_AGENT_MEMORY_ROOT` | `~/.caveman/agent-memory` | Where memory namespaces persist |

## Gateway and runtime

| Variable | Default | Meaning |
| --- | --- | --- |
| `CAVE_GATEWAY_URL` | loopback default | Local Cave gateway endpoint |
| `CAVE_API_KEY` | unset | Account key used only on gateway-routed requests. Off the gateway, no `x-cave-*` header is sent at all |
| `CAVEMAN_CLI_BIN` | `caveman` | Public Caveman CLI binary (probed with `caveman version`) |
| `CAVEMAN_ENGINE_BIN` | `caveman-engine` | Local engine binary |
| `CAVEMAN_PROXY_BIN` | resolved under `CAVEMAN_HOME` | Proxy binary override |
| `CAVE_AGENT_ENGINE_DETECT_TIMEOUT_MS` | `10000` | Engine detection timeout |
| `CLAUDE_BIN` | `claude` | Binary `doctor` probes for the Claude lane version |

## Serving

| Variable | Required | Meaning |
| --- | --- | --- |
| `CAVE_SERVE_TOKEN` | yes | Bearer token for `POST /runs`. No unauthenticated mode; under 16 characters is refused |
| `CAVE_JOURNAL_URL` | no | Switches the journal to `HttpDurableStore`. Must be `https://` outside localhost |
| `CAVE_JOURNAL_TOKEN` | with `CAVE_JOURNAL_URL` | Bearer token for that journal. Missing it refuses at startup |
| `PORT` | no | Listen port, default `8080` (`--port` wins) |
| `HOST` | no | Listen host, default `0.0.0.0` (`--host` wins) |

## Build registration

All three are required by `caveman-agent register`:

| Variable | Meaning |
| --- | --- |
| `CAVE_CONTROL_URL` | Control-plane base URL |
| `CAVE_TOKEN` (or `CAVE_API_TOKEN`) | Bearer token |
| `CAVE_PROJECT_ID` | Target project |

## Caveman Connect

Passed through to `cave-connectd`. Provider keys and `CAVE_CONNECT_SECRET_KEY`
are **stripped** before the child starts.

| Variable | Meaning |
| --- | --- |
| `CAVE_CONNECT_BIN` | Absolute path to `cave-connectd`; otherwise `PATH` is searched |
| `CAVE_CONNECT_HOST` / `CAVE_CONNECT_PORT` | Daemon endpoint |
| `CAVE_CONNECT_DATA_DIR` / `CAVE_CONNECT_RUNTIME_DIR` | Daemon storage |
| `CAVE_CONNECT_RELAY_URL` | Hosted relay for fixed-callback OAuth |
| `CAVE_CONNECT_FIXED_CALLBACK_PROVIDERS` | Providers needing the relay |
| `CAVE_CONNECT_DEVICE_CODE_OVERRIDES` | Device-code flow overrides |
| `CAVE_CONNECT_NODE` | Node binary the daemon should use |
| `CAVE_CONNECT_ACTION_CONCURRENCY` | Daemon action concurrency |

The full child allowlist is exactly:

```text
HOME USER LOGNAME PATH TMPDIR LANG LC_ALL TERM NO_COLOR
XDG_DATA_HOME XDG_CONFIG_HOME XDG_CACHE_HOME
CAVE_CONNECT_HOST CAVE_CONNECT_PORT CAVE_CONNECT_DATA_DIR
CAVE_CONNECT_RELAY_URL CAVE_CONNECT_FIXED_CALLBACK_PROVIDERS
CAVE_CONNECT_DEVICE_CODE_OVERRIDES CAVE_CONNECT_NODE
CAVE_CONNECT_ACTION_CONCURRENCY CAVE_CONNECT_RUNTIME_DIR
```

## Subprocess baselines

### Tool worker / engine subprocess

Starts from a fixed baseline, **not** a spread of the parent environment:

```text
LANG  LC_ALL  PATH  HOME  TZ
```

plus, when set, the portable launch baseline and exact local-engine
configuration — none of which carries an account or provider secret:

```text
ComSpec PATHEXT SystemRoot TEMP TMP TMPDIR USERPROFILE
CAVEMAN_CCR_DB CAVEMAN_HOME
CAVE_ENGINE_TOON CAVE_PIXEL_DENSITY CAVE_PIXEL_GPT_PROFILES CAVE_PIXEL_MODELS
CAVE_FAKE_ENGINE_STORE
```

Plus at most one provider credential family, when the sandbox profile requests it.

### Runtime control / ownership probes

These subprocesses never need provider, account, deployment, or session
credentials — their binaries may resolve from a package-script `PATH`, so a
spread of `process.env` would turn `PATH` shadowing into secret exfiltration.

```text
LANG LC_ALL PATH HOME TZ
ComSpec PATHEXT SystemRoot TEMP TMP TMPDIR USERPROFILE
CAVEMAN_CCR_DB CAVEMAN_CONFIG CAVEMAN_HOME CAVEMAN_MCP CAVEMAN_MODE
CAVEMAN_OFFLINE CAVEMAN_PLAIN CAVEMAN_PROXY_BIN CAVEMAN_RECOVERY
CAVEMAN_SHRINK CAVEMAN_TELEMETRY CAVEMAN_TOON CAVEMAN_WRAP_MODE
CAVE_ENGINE_TOON CAVE_GATEWAY_URL
CAVE_PIXEL_DENSITY CAVE_PIXEL_GPT_PROFILES CAVE_PIXEL_MODELS
CI DO_NOT_TRACK NO_COLOR TERM
```

### The coding agent's `bash`

A fixed shell/locale allow-list, not a spread of `process.env`, so a model-driven
command cannot read `CAVE_API_KEY`, `ANTHROPIC_API_KEY`, or any other framework
credential and exfiltrate it.

## Internal / test-only

| Variable | Purpose |
| --- | --- |
| `CAVE_SANDBOX_HOME_PROBE` | Path the sandbox conformance probe attempts to read; a successful read means containment failed |
| `CAVE_FAKE_ENGINE_STORE` | Test engine store |
| `CAVE_EVAL_FIXTURE` | Fixture marker seen by tools in fixture mode |

Do not rely on these in production configuration.
