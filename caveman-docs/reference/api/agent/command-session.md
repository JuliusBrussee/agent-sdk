# `@caveman-ai/agent/command-session`

> Generated from the built type declarations by `node scripts/generate-docs-api.mjs`.
> Do not edit by hand. Version at generation time: `0.2.0`.

Declaration file: `packages/agent/dist/command-session.d.ts`.

<details><summary>Symbol index</summary>

- **Interface**: `CommandSessionReadOptions`, `CommandSessionReadResult`, `CommandSessionRuntime`, `CommandSessionRuntimeOptions`, `CommandSessionSpillOptions`, `CommandSessionStartOptions`, `CommandSessionStartResult`, `CommandSessionSummary`, `CommandSessionWriteOptions`, `CommandSessionWriteResult`
- **Type alias**: `CommandSessionState`
- **Function**: `createCommandSessionRuntime`

</details>

## Interfaces

### `CommandSessionReadOptions`

```ts
export interface CommandSessionReadOptions {
    sessionId: string;
    /** Absolute byte position in this session's combined stdout/stderr stream. */
    cursor?: number;
    /** Case-sensitive literal UTF-8 byte query. Returns the first retained match. */
    query?: string;
    limit?: number;
    /** Query reads wait for a match; other reads wait for bytes after `cursor`. */
    waitMs?: number;
    /** Cancels this read only. It never kills the session. */
    signal?: AbortSignal;
}
```

Declared in `packages/agent/dist/command-session.d.ts`.

### `CommandSessionReadResult`

```ts
export interface CommandSessionReadResult {
    readonly sessionId: string;
    readonly state: CommandSessionState;
    /** Requested absolute cursor. */
    readonly cursor: number;
    /**
     * Absolute cursor of the first returned byte. May advance when old bytes were
     * evicted, or begin before a query cursor when one literal spans that cursor.
     */
    readonly outputStart: number;
    /** Absolute cursor immediately after the returned bytes. */
    readonly nextCursor: number;
    /** `base64` preserves an exact page whose byte boundaries are not valid UTF-8. */
    readonly outputEncoding: "utf8" | "base64";
    readonly output: string;
    readonly availableFrom: number;
    readonly availableTo: number;
    readonly truncatedBeforeCursor: boolean;
    readonly hasMore: boolean;
    /** Query reads only: absolute first match, or `null` when scanned bytes had none. */
    readonly matchStart?: number | null;
    readonly exitCode: number | null;
    readonly exitSignal: NodeJS.Signals | null;
    readonly spawnError?: string;
}
```

Declared in `packages/agent/dist/command-session.d.ts`.

### `CommandSessionRuntime`

```ts
export interface CommandSessionRuntime {
    start(options: CommandSessionStartOptions): Promise<CommandSessionStartResult>;
    /** Snapshot retained sessions in start order. Command text is not retained or exposed. */
    list(): readonly CommandSessionSummary[];
    read(options: CommandSessionReadOptions): Promise<CommandSessionReadResult>;
    write(options: CommandSessionWriteOptions): Promise<CommandSessionWriteResult>;
    kill(sessionId: string): Promise<CommandSessionReadResult>;
    /** Kill every live child and wait for local handles to close. Idempotent. */
    close(): Promise<void>;
}
```

Declared in `packages/agent/dist/command-session.d.ts`.

### `CommandSessionRuntimeOptions`

```ts
export interface CommandSessionRuntimeOptions {
    /** Maximum simultaneously retained sessions. Completed sessions are evicted first. */
    maxSessions?: number;
    /** Maximum in-memory output bytes per session. Older bytes spill or discard first. */
    maxOutputBytes?: number;
    /** Optional bounded exact-output recovery for bytes evicted from memory. */
    spill?: CommandSessionSpillOptions;
    /** Maximum bytes returned by one read. */
    maxReadBytes?: number;
    /** Maximum bytes accepted by one stdin write. */
    maxInputBytes?: number;
    /** Maximum hard process lifetime. */
    maxTimeoutMs?: number;
    /** Maximum long-poll duration for one read. */
    maxWaitMs?: number;
}
```

Declared in `packages/agent/dist/command-session.d.ts`.

### `CommandSessionSpillOptions`

```ts
export interface CommandSessionSpillOptions {
    /** Existing absolute directory for private spill files. */
    directory: string;
    /** Maximum additional retained bytes per session. */
    maxBytes: number;
}
```

Declared in `packages/agent/dist/command-session.d.ts`.

### `CommandSessionStartOptions`

```ts
export interface CommandSessionStartOptions {
    command: string;
    args?: readonly string[];
    cwd: string;
    /** Explicit child environment. Ambient `process.env` is never inherited. */
    env: NodeJS.ProcessEnv;
    /** Session commands keep stdin writable by default; foreground callers may close it at launch. */
    stdin?: "pipe" | "closed";
    timeoutMs: number;
    signal?: AbortSignal;
}
```

Declared in `packages/agent/dist/command-session.d.ts`.

### `CommandSessionStartResult`

```ts
export interface CommandSessionStartResult {
    readonly sessionId: string;
    readonly state: "running";
}
```

Declared in `packages/agent/dist/command-session.d.ts`.

### `CommandSessionSummary`

```ts
export interface CommandSessionSummary {
    readonly sessionId: string;
    readonly state: CommandSessionState;
    readonly availableFrom: number;
    readonly availableTo: number;
    readonly stdinOpen: boolean;
    readonly exitCode: number | null;
    readonly exitSignal: NodeJS.Signals | null;
    readonly spawnError?: string;
}
```

Declared in `packages/agent/dist/command-session.d.ts`.

### `CommandSessionWriteOptions`

```ts
export interface CommandSessionWriteOptions {
    sessionId: string;
    input: string;
    /** End stdin after this input is flushed, allowing readers to observe EOF. */
    closeStdin?: boolean;
    /** Cancels this write operation only. It never kills the session. */
    signal?: AbortSignal;
}
```

Declared in `packages/agent/dist/command-session.d.ts`.

### `CommandSessionWriteResult`

```ts
export interface CommandSessionWriteResult {
    readonly sessionId: string;
    readonly state: CommandSessionState;
    readonly accepted: boolean;
    readonly bytes: number;
    /**
     * Absolute output end captured before the stdin write attempt. Unknown
     * sessions return `0` because no owned output stream exists.
     */
    readonly outputCursor: number;
}
```

Declared in `packages/agent/dist/command-session.d.ts`.

## Type aliases

### `CommandSessionState`

```ts
export type CommandSessionState = "running" | "exited" | "timed_out" | "killed" | "unknown_after_restart";
```

Declared in `packages/agent/dist/command-session.d.ts`.

## Functions

### `createCommandSessionRuntime`

Create a command-session owner. Output stays memory-only unless bounded
spill is explicitly configured. IDs deliberately name only this runtime's
children: unknown IDs are reported as `unknown_after_restart` and are never
adopted from operating-system process state.

```ts
export declare function createCommandSessionRuntime(options?: CommandSessionRuntimeOptions): CommandSessionRuntime;
```

Declared in `packages/agent/dist/command-session.d.ts`.

