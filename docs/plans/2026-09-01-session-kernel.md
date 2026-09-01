# Session kernel plan (2026-09-01)

Goal: make `@caveman-ai/agent` the obvious runtime for a Ramp-"Inspect"-style
background agent: server-first sessions with follow-up queueing, tools that
execute in a remote sandbox, per-session durable stores, a test kit, sane
defaults, and a front door with one-fifth of today's concept load.

Repo invariants still apply (AGENTS.md): never rebuild Pi surfaces; fail
closed on unknown state; host execution is never isolation; explicit env
allowlists; `runtime.ts` must not grow (size budget headroom is 38 lines —
put new code in new files); regenerate `api-surface.txt` with
`npm run api:update` and justify every added export.

## Stage 1 — parallel, disjoint file sets

### S1 Execution backend (files: NEW `packages/agent/src/execution-backend.ts`, `code.ts`, `command-session.ts`, `index.ts`/`package.json` exports append-only, tests)

Interfaces (Produces):

```ts
// packages/agent/src/execution-backend.ts
export interface ExecResult {
  readonly stdout: string; readonly stderr: string;
  readonly code: number | null; readonly timedOut: boolean;
  readonly truncated: boolean;
}
export interface ExecRequest {
  readonly command: string; readonly args: readonly string[];
  readonly cwd: string; readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number; readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
}
export interface ExecutionBackend {
  readonly id: string;                     // "local" | "http" | user-defined
  exec(request: ExecRequest): Promise<ExecResult>;
  readFile(path: string, opts?: { maxBytes?: number }): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  /** Optional lifecycle. A host that prewarms calls prepare() before the first turn. */
  prepare?(): Promise<void>;
  snapshot?(): Promise<string>;            // opaque snapshot id, backend-defined
  restore?(snapshotId: string): Promise<void>;
  close?(): Promise<void>;
}
export function localExecutionBackend(): ExecutionBackend;
export function httpExecutionBackend(opts: { url: string; token: string; fetch?: typeof fetch }): ExecutionBackend;
```

`httpExecutionBackend` speaks a tiny JSON contract any sandbox provider
(Modal, E2B, Fly, Daytona, a plain container) can satisfy with ~40 lines:
`POST {url}/exec`, `POST {url}/read`, `POST {url}/write`, optional
`POST {url}/prepare|snapshot|restore`, bearer token, JSON bodies mirroring
the interfaces above, bytes base64. Document the contract in a comment block
at the top of the file and in `packages/agent/docs/execution-backend.md`.

Wiring: `CodingAgentOptions.executionBackend?: ExecutionBackend` (default
`localExecutionBackend()`). Every coding tool that shells out or touches
the workspace filesystem (`bash`, `read`, `write`, `edit`, `grep`, `ls`,
command sessions) routes through the backend. Interactive command sessions
(`command-session.ts`) may stay local-only: if a non-local backend is set and
the command-session tool is enabled, fail closed with
`cave_execution_backend_command_sessions_local_only` at agent construction.
Env passed to `exec` must still come from the existing explicit allowlist.

Verify: `npm --prefix packages/agent test` green; new test proves a fake
`ExecutionBackend` receives every `bash`/`read`/`write` call and no
`child_process`/`fs` call reaches the host for those tools.

### S2 Sessions, fetch handler, WebSocket, React (files: `serve.ts` → split into NEW `serve-handler.ts` (web-standard) + `serve.ts` (node wrapper), NEW `serve-session.ts`, `cli.ts` serve command only, `packages/react/*`, `caveman-docs/guides/11-serving-and-hosting.md`, tests)

Interfaces (Produces):

```ts
// serve-handler.ts — no node:http import. Runs in Node, Cloudflare DO, Deno, Bun.
export interface AgentHandlerOptions extends Omit<AgentServerOptions, "runOptions"> {
  /** Per-run options; a factory so controllers/signals are never shared. */
  runOptions?: (context: { sessionId: string; runId: string }) => Omit<RunOptions, "durable" | "controller" | "signal" | "conversation">;
  /** Optional WebSocket factory for hosts that own upgrades (Cloudflare WebSocketPair, `ws`). */
  upgrade?: (request: Request) => { response: Response; socket: WebSocketLike } | undefined;
}
export interface WebSocketLike { send(data: string): void; close(code?: number, reason?: string): void; addEventListener(type: "message"|"close"|"error", fn: (ev: any) => void): void }
export interface AgentHandler {
  fetch(request: Request): Promise<Response>;
  recover(): Promise<RecoveryReport>;
  nextWakeAt(): Promise<Date | undefined>;
  close(graceMs?: number): Promise<void>;
}
export function createAgentHandler(options: AgentHandlerOptions): AgentHandler;

// serve.ts keeps createAgentServer(options) with the SAME shape as today plus
// `runOptions` accepting either the old object or the new factory. It wraps
// createAgentHandler in node:http, and wires WebSocket upgrades through the
// optional `ws` peer (fail closed with cave_serve_websocket_unavailable if a
// client upgrades and `ws` is not installed).
```

HTTP contract (keep every existing `/runs` route byte-identical; add):

```text
POST   /sessions                       {"sessionId":"…"}                 → 201 {sessionId}
POST   /sessions/{id}/messages         {"text":"…","author"?:"…","mode"?:"followUp"|"steer"} → 202 {runId,queued:boolean}
GET    /sessions/{id}                  → {sessionId, runs:[…], active?:runId, queued:number}
GET    /sessions/{id}/events           SSE, same Pebble frames as /runs/:id/events, across runs
DELETE /sessions/{id}                  cancel active run, drop queue
WS     /sessions/{id}/ws               bidirectional: client→{type:"message",text,author?,mode?} | {type:"cancel"}; server→Pebble frames
```

Semantics: a session owns one `Conversation` and one `AgentRunController`.
A message while a run is active goes to `controller.followUp` (default) or
`controller.steer`. A message while idle starts run `${sessionId}.${n}` with
the session's conversation. The conversation survives restarts: on session
load, rebuild it from the last run's journaled terminal
`DurableConversationCheckpoint` (durable.ts `durableConversationCheckpoint`);
if no checkpoint is reconstructable, fail closed with
`cave_session_conversation_unrecoverable` rather than starting fresh silently.
`author` is stored on the journaled user message metadata and echoed on the
`turn.start` frame so multiplayer clients can attribute. No scheduler, no
cross-session orchestration.

React: fix the `stopWatching` doc (there IS `DELETE /runs/:id`), add
`useSession({ url, sessionId, token })` returning `{ events, send(text, opts), cancel(), status }`
over SSE or WS (WS when `WebSocket` global exists and `transport: "ws"`).

Verify: serve tests green; new tests: two clients on one session both see
frames from two consecutive runs; follow-up while active is queued and
drained; restart re-hydrates conversation; fetch handler runs under a fake
`Request` with no node:http.

### S3 Stores, test kit, defaults, honesty (files: `durable-stores.ts`, NEW `durable-sql-store.ts`, NEW `durable-object-store.ts`, NEW `testing.ts`, `definition.ts`, `runtime.ts` (ONLY `resolveModel`, net zero lines), `gateway.ts`, `index.ts`/`package.json` exports append-only, `caveman-docs/guides/10-durable-runs.md`, tests)

Interfaces (Produces):

```ts
// durable-sql-store.ts — dependency-free; works with Cloudflare DO SqlStorage, better-sqlite3, pg, postgres.js
export interface SqlExecutor { exec(sql: string, params: readonly unknown[]): Promise<ReadonlyArray<Record<string, unknown>>> | ReadonlyArray<Record<string, unknown>>; }
export class SqlDurableStore implements DurableStore { constructor(opts: { sql: SqlExecutor; dialect: "sqlite" | "postgres"; table?: string }); static schema(dialect): string }
// durable-object-store.ts — S3/R2/GCS via a 3-method adapter
export interface ObjectStorage { get(key: string): Promise<Uint8Array | undefined>; put(key: string, data: Uint8Array, opts?: { ifMatch?: string }): Promise<void>; list(prefix: string): Promise<readonly string[]>; }
export class ObjectDurableStore implements DurableStore { constructor(opts: { storage: ObjectStorage; prefix?: string }) }
// testing.ts — exported as "@caveman-ai/agent/testing"
export function fauxModel(opts?: { provider?: string; id?: string; priced?: boolean }): Model<Api>;
export function scriptedStream(turns: ReadonlyArray<{ text?: string; toolCalls?: ReadonlyArray<{ name: string; args: unknown }>; usage?: Partial<ModelUsage> }>): StreamFn;
```

Lift `fauxModel`/`scriptedStream` from what `tests/budget-regressions.runtime.mjs:23-60`
already does; then make at least two existing test files use the export.
Locking semantics of `DurableStore.acquire` must be honored in both stores
(SQL: row lease with expiry; object: conditional put on a lease key).

Defaults:
- `agent()` without `sandbox`: default stays `"required"` ONLY when
  `RunOptions.entryPath` is supplied at run time; `run()`/`stream()` with a
  definition that never declared `sandbox` and no `entryPath` executes as
  `"host"` and prints one stderr line `cave: host execution — tools are not isolated` once per process. An explicit `sandbox: "required"` still fails closed without `entryPath`.
  Implement by recording `sandboxDeclared: boolean` on the definition (append-only field).
- `auto()`: when several credentials are present, pick by fixed order
  anthropic → openai → google and print one stderr warning naming `CAVE_MODEL`;
  never throw for that case. Zero credentials still throws.

Honesty:
- `gateway.ts` `ensureRuntime: false` + loopback: probe `/healthz` (bounded 250 ms);
  unreachable → observe-only with the existing degrade reason. Never `useGateway: true` unprobed.
- A caller-supplied `streamFn` can never yield `mode: "optimized"`. Add a test.

Verify: durable + serve + budget + framework tests green; new tests for both
stores (use in-memory fakes for `SqlExecutor`/`ObjectStorage`), the two
default changes, and both honesty fixes.

## Stage 2 — after Stage 1 merges

### S4 Front door, template, naming (files: `README.md`, `packages/agent/README.md`, `caveman-docs/**`, `packages/create-caveman-agent/**` (new template `background-agent`), `packages/adapters/*/README.md`, `examples/README.md`)

- README and getting-started lead with: define → run → serve (sessions) →
  durable store → execution backend → budget. Build/evals/locks/gateway/
  Engine/Connect move to a "Going further" section that links out. First
  code sample must run with one key and zero config.
- Modes: the default is described as **direct** ("your key, your provider,
  no proxy"); the receipt value stays `observe-only` and the glossary maps it.
  `optimized` is described once, as optional.
- Glossary: cut to ≤ 25 entries; every remaining entry names the file that
  owns it.
- Adapters: every adapter README's first line says "observability adapter:
  records lifecycle and usage from a native <framework> loop; it does not
  run a Caveman agent". Package names unchanged (rename deferred: 9
  workspaces + conformance fixtures).
- New template `background-agent`: `instructions.md`, `agent.ts` (host mode,
  `budget`, `breakers`), `server.ts` (`createAgentServer` + `SqlDurableStore`
  over better-sqlite3 in dev / DO in prod, `httpExecutionBackend` when
  `CAVE_EXEC_URL` set else local), `tools/` uses `createConnect` for GitHub
  as the integration example, no evals, no build config. `npm run dev` starts
  the server; README shows `curl` for create session → send message → tail
  events, and the 40-line sandbox-provider shim for the exec contract.
- Regenerate `caveman-docs/reference/api` with `npm run docs:api`.

Verify: `npm run test:create-agent`, `npm run test:example`, markdown links resolve.

## Integration (orchestrator)

Merge S1, S3, S2 in that order onto `feat/session-kernel`, run
`npm run api:update` once, `npm test`, then dispatch S4, then adversarial
review, then final `npm test` + `npm run pack:check`.
