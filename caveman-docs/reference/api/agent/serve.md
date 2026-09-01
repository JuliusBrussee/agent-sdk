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
    readonly server: Server;
    listen(port: number, host?: string): Promise<number>;
    recover(): Promise<RecoveryReport>;
    nextWakeAt(): Promise<Date | undefined>;
    close(graceMs?: number): Promise<void>;
}
```

Declared in `packages/agent/dist/serve.d.ts`.

### `AgentServerOptions`

```ts
export interface AgentServerOptions {
    definition: AgentDefinition;
    token: string;
    store?: DurableStore;
    rootDir?: string;
    build?: AnyCaveBuildLock;
    /** Existing object form, or factory producing isolated per-run options. */
    runOptions?: Omit<RunOptions, "durable"> | PerRunOptionsFactory;
    maxConcurrentRuns?: number;
    maxQueuedRuns?: number;
    maxBodyBytes?: number;
}
```

Declared in `packages/agent/dist/serve.d.ts`.

### `RecoveryReport`

```ts
export interface RecoveryReport {
    readonly listable: boolean;
    readonly resumed: readonly string[];
    readonly sleeping: ReadonlyArray<{
        readonly runId: string;
        readonly wakeAt: string;
    }>;
    readonly skipped: ReadonlyArray<{
        readonly runId: string;
        readonly reason: string;
    }>;
}
```

Declared in `packages/agent/dist/serve-handler.d.ts`.

## Functions

### `createAgentServer`

```ts
export declare function createAgentServer(options: AgentServerOptions): AgentServer;
```

Declared in `packages/agent/dist/serve.d.ts`.

