# Execution backends

`CodingAgentOptions.executionBackend` moves coding-agent process and workspace
effects behind one host-owned boundary. Default `localExecutionBackend()` keeps
existing host behavior. Host execution remains uncontained host execution; this
interface does not claim isolation.

Remote providers use `httpExecutionBackend({ url, token })`. Every request is a
JSON `POST` with these headers:

```text
Authorization: Bearer <token>
Content-Type: application/json
```

Contract:

| Endpoint | Request JSON | Success JSON |
| --- | --- | --- |
| `/exec` | `{command,args,cwd,env,timeoutMs,maxOutputBytes}` | `{stdout,stderr,code,timedOut,truncated}` |
| `/read` | `{path,maxBytes?}` | `{data}` (`data` is base64) |
| `/write` | `{path,data}` (`data` is base64) | `{}` |
| `/prepare` (optional) | `{}` | `{}` |
| `/snapshot` (optional) | `{}` | `{snapshotId}` |
| `/restore` (optional) | `{snapshotId}` | `{}` |

`/read` returns HTTP 404 for a missing path. Every other non-2xx response fails
closed. `/exec` must enforce `timeoutMs` and `maxOutputBytes`; `truncated` is
true whenever bytes were discarded. Client also bounds oversized responses to
`maxOutputBytes`. `AbortSignal` is not serialized; client uses it to cancel
HTTP request.

`env` is explicit allowlisted coding environment produced by SDK. Server must
use supplied map as complete child environment and must not merge ambient
provider secrets.

Interactive command sessions are local-only. Remote backends support bounded
foreground `bash`; `yieldTimeMs` and session operations fail with
`cave_execution_backend_command_sessions_local_only`. Setting
`commandSessions: true` or configuring command-session spill with non-local
backend fails with same code during agent construction. Provider must enforce
its own workspace-root containment for remote paths, including symlink targets.
