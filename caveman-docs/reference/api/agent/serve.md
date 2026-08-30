# `@caveman-ai/agent/serve`

> Generated from the built type declarations by `node scripts/generate-docs-api.mjs`.
> Do not edit by hand. Version at generation time: `0.2.0`.

Declaration file: `packages/agent/dist/serve.d.ts`.

<details><summary>Symbol index</summary>

- **Interface**: `AgentServer`, `AgentServerOptions`, `RecoveryReport`
- **Function**: `createAgentServer`

</details>

## Interfaces

### `AgentServer`

```ts
export interface AgentServer {
    /** The underlying server, for callers that own their own listen/upgrade wiring. */
    readonly server: Server;
    /** Bind and start accepting. Resolves with the bound port. */
    listen(port: number, host?: string): Promise<number>;
    /**
     * Re-drive every pending journal. Called once by `listen`; `/readyz` stays
     * 503 until it resolves, so a platform does not route traffic to an
     * instance that has not yet reclaimed its own crashed work.
     */
    recover(): Promise<RecoveryReport>;
    /**
     * Earliest instant any journaled run becomes due, or undefined when nothing
     * is sleeping (or the store cannot enumerate, which is unknown, not empty).
     *
     * This is the scale-to-zero hook: a platform can shut the instance down and
     * bring one back at exactly this time instead of paying for a process that
     * only watches a clock.
     */
    nextWakeAt(): Promise<Date | undefined>;
    /** Stop intake, let in-flight runs settle for `graceMs`, then close. */
    close(graceMs?: number): Promise<void>;
}
```

Declared in `packages/agent/dist/serve.d.ts`.

### `AgentServerOptions`

```ts
export interface AgentServerOptions {
    /** The agent every run on this server executes. */
    definition: AgentDefinition;
    /**
     * Bearer token required on `/runs`. No default and no unauthenticated
     * mode: this endpoint spends money and returns model output.
     */
    token: string;
    /** Journal storage. Defaults to disk under `<rootDir>/.caveman/runs/durable`. */
    store?: DurableStore;
    /** Working root for the agent and the default store. Defaults to `process.cwd()`. */
    rootDir?: string;
    /** When present every run executes through the frozen build instead of `run()`. */
    build?: AnyCaveBuildLock;
    /** Run defaults. `durable` is owned by the server and cannot be supplied. */
    runOptions?: Omit<RunOptions, "durable">;
    /** Runs driven at once. Default 2 — model calls are the bottleneck, not CPU. */
    maxConcurrentRuns?: number;
    /** Accepted-but-not-started ceiling before `POST /runs` sheds load. Default 64. */
    maxQueuedRuns?: number;
    /** Request body ceiling. Default 1 MiB. */
    maxBodyBytes?: number;
}
```

Declared in `packages/agent/dist/serve.d.ts`.

### `RecoveryReport`

```ts
export interface RecoveryReport {
    /** False when the store cannot enumerate runs, so no sweep was possible. */
    readonly listable: boolean;
    /** Pending runs re-queued from their journals. */
    readonly resumed: readonly string[];
    /**
     * Pending runs deliberately left alone because their durable sleep has not
     * elapsed. Separate from `skipped`: these are healthy runs waiting on a
     * clock, not runs this server could not drive.
     */
    readonly sleeping: ReadonlyArray<{
        readonly runId: string;
        readonly wakeAt: string;
    }>;
    /** Pending runs this server refused to auto-resume, each with its reason. */
    readonly skipped: ReadonlyArray<{
        readonly runId: string;
        readonly reason: string;
    }>;
}
```

Declared in `packages/agent/dist/serve.d.ts`.

## Functions

### `createAgentServer`

```ts
export declare function createAgentServer(options: AgentServerOptions): AgentServer;
```

Declared in `packages/agent/dist/serve.d.ts`.

