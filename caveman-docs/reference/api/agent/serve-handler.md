# `@caveman-ai/agent/serve-handler`

> Generated from the built type declarations by `node scripts/generate-docs-api.mjs`.
> Do not edit by hand. Version at generation time: `0.2.0`.

Declaration file: `packages/agent/dist/serve-handler.d.ts`.

<details><summary>Symbol index</summary>

- **Interface**: `AgentHandler`, `AgentHandlerOptions`, `RecoveryReport`, `WebSocketLike`
- **Function**: `createAgentHandler`

</details>

## Interfaces

### `AgentHandler`

```ts
export interface AgentHandler {
    fetch(request: Request): Promise<Response>;
    recover(): Promise<RecoveryReport>;
    nextWakeAt(): Promise<Date | undefined>;
    close(graceMs?: number): Promise<void>;
}
```

Declared in `packages/agent/dist/serve-handler.d.ts`.

### `AgentHandlerOptions`

```ts
export interface AgentHandlerOptions extends Omit<AgentServerOptions, "runOptions"> {
    /** Per-run options; controllers, signals, conversations, and durability are handler-owned. */
    runOptions?: (context: {
        sessionId: string;
        runId: string;
    }) => Omit<RunOptions, "durable" | "controller" | "signal" | "conversation">;
    /** Host-owned WebSocket upgrade (Cloudflare WebSocketPair, Deno, Bun, or Node ws wrapper). */
    upgrade?: (request: Request) => {
        response: Response;
        socket: WebSocketLike;
    } | undefined;
}
```

Declared in `packages/agent/dist/serve-handler.d.ts`.

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

### `WebSocketLike`

```ts
export interface WebSocketLike {
    send(data: string): void;
    close(code?: number, reason?: string): void;
    addEventListener(type: "message" | "close" | "error", fn: (event: any) => void): void;
}
```

Declared in `packages/agent/dist/serve-handler.d.ts`.

## Functions

### `createAgentHandler`

```ts
export declare function createAgentHandler(options: AgentHandlerOptions): AgentHandler;
```

Declared in `packages/agent/dist/serve-handler.d.ts`.

