# `@caveman-ai/agent/connect`

> Generated from the built type declarations by `node scripts/generate-docs-api.mjs`.
> Do not edit by hand. Version at generation time: `0.2.0`.

Declaration file: `packages/agent/dist/connect.d.ts`.

<details><summary>Symbol index</summary>

- **Class**: `ConnectRuntime`
- **Interface**: `ConnectAction`, `ConnectConnection`, `ConnectEfficiencyComparison`, `ConnectEfficiencyRun`, `ConnectExecuteOptions`, `ConnectIntegration`, `ConnectMcpCallResult`, `ConnectMcpTool`, `ConnectMcpToolAnnotations`, `ConnectMcpToolExecution`, `ConnectMcpToolIcon`, `ConnectOptions`, `ConnectProcessResult`, `ConnectQualityPolicy`, `ConnectRuntimeOptions`, `ConnectSource`, `ConnectToolRuntimeDefinition`, `NormalizedConnectAction`, `NormalizedConnectQualityPolicy`, `NormalizedConnectSource`
- **Type alias**: `ConnectActionBindValue`, `ConnectExecutor`
- **Function**: `compareConnectEfficiency`, `connectEnvironment`, `createConnect`, `executeConnectTool`, `resolveConnectBinary`

</details>

## Classes

### `ConnectRuntime`

```ts
export declare class ConnectRuntime {
    #private;
    constructor(options?: ConnectRuntimeOptions);
    delegate(args: readonly string[], signal?: AbortSignal): Promise<number>;
    connect(provider: string, onOutput?: ConnectExecuteOptions["onOutput"], signal?: AbortSignal): Promise<void>;
    call(toolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ConnectMcpCallResult>;
    /** Lists detached connection metadata. Credential fields are never projected. */
    connections(signal?: AbortSignal): Promise<readonly ConnectConnection[]>;
    /**
     * Lists every MCP tool through exact cursor pagination. Discovery is bounded
     * and returns only detached, deeply frozen plain data.
     */
    listTools(signal?: AbortSignal): Promise<readonly ConnectMcpTool[]>;
}
```

Declared in `packages/agent/dist/connect.d.ts`.

## Interfaces

### `ConnectAction`

```ts
export interface ConnectAction {
    /** Curated provider action name. */
    readonly name: string;
    /** Argument values fixed by config. Model input may not set these keys. */
    readonly bind?: Readonly<Record<string, ConnectActionBindValue>>;
}
```

Declared in `packages/agent/dist/connect.d.ts`.

### `ConnectConnection`

Credential-free saved-connection projection returned by cave-connectd.

```ts
export interface ConnectConnection {
    readonly connectionId: string;
    readonly provider: string;
    readonly authMode: string;
    readonly status: string;
}
```

Declared in `packages/agent/dist/connect.d.ts`.

### `ConnectEfficiencyComparison`

```ts
export interface ConnectEfficiencyComparison {
    readonly evidence: "inferred";
    readonly accepted: boolean;
    readonly reasons: readonly string[];
    readonly baselineTotalCostUsd: number | null;
    readonly connectedTotalCostUsd: number | null;
    readonly costDeltaUsd: number | null;
    readonly inputTokenDelta: number | null;
    readonly retryDelta: number;
    readonly qualityDelta: number;
}
```

Declared in `packages/agent/dist/connect.d.ts`.

### `ConnectEfficiencyRun`

```ts
export interface ConnectEfficiencyRun {
    readonly taskSuccess: boolean;
    /** Same grader and scale required for baseline and connected run. */
    readonly quality: number;
    /** Provider/model spend only when complete; otherwise null. */
    readonly providerCostUsd: number | null;
    readonly providerInputTokens: number | null;
    readonly providerOutputTokens: number | null;
    readonly retries: number;
    readonly retrievalCalls: number;
    readonly retrievalCostUsd: number | null;
    readonly collectionCostUsd: number | null;
    readonly completeData: boolean;
}
```

Declared in `packages/agent/dist/connect.d.ts`.

### `ConnectExecuteOptions`

```ts
export interface ConnectExecuteOptions {
    readonly environment: Readonly<Record<string, string>>;
    readonly capture: boolean;
    readonly input?: string;
    readonly signal?: AbortSignal;
    readonly timeoutMs: number;
    readonly maxCaptureBytes: number;
    readonly onOutput?: (value: string, stream: "stdout" | "stderr") => void;
}
```

Declared in `packages/agent/dist/connect.d.ts`.

### `ConnectIntegration`

```ts
export interface ConnectIntegration {
    readonly tool: ToolDefinition;
    readonly sources: readonly NormalizedConnectSource[];
    readonly quality: NormalizedConnectQualityPolicy;
    /** Open provider authorization. Credentials remain owned by cave-connectd. */
    connect(sourceId: string, onOutput?: ConnectExecuteOptions["onOutput"]): Promise<void>;
    /** Trigger every configured sync once. Returns exact daemon acknowledgements. */
    collect(sourceId?: string, signal?: AbortSignal): Promise<readonly unknown[]>;
    /** Read saved connections without credential material. */
    connections(signal?: AbortSignal): Promise<readonly ConnectConnection[]>;
}
```

Declared in `packages/agent/dist/connect.d.ts`.

### `ConnectMcpCallResult`

```ts
export interface ConnectMcpCallResult {
    readonly isError: boolean;
    readonly structuredContent: unknown;
    readonly content: readonly unknown[];
}
```

Declared in `packages/agent/dist/connect.d.ts`.

### `ConnectMcpTool`

Detached, deeply frozen MCP tool descriptor. Annotation values remain hints.

```ts
export interface ConnectMcpTool {
    readonly name: string;
    readonly title?: string;
    readonly description?: string;
    readonly inputSchema: Readonly<Record<string, unknown>>;
    readonly outputSchema?: Readonly<Record<string, unknown>>;
    readonly annotations?: ConnectMcpToolAnnotations;
    readonly execution?: ConnectMcpToolExecution;
    readonly icons?: readonly ConnectMcpToolIcon[];
    readonly _meta?: Readonly<Record<string, unknown>>;
}
```

Declared in `packages/agent/dist/connect.d.ts`.

### `ConnectMcpToolAnnotations`

```ts
export interface ConnectMcpToolAnnotations {
    readonly title?: string;
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
    readonly idempotentHint?: boolean;
    readonly openWorldHint?: boolean;
}
```

Declared in `packages/agent/dist/connect.d.ts`.

### `ConnectMcpToolExecution`

```ts
export interface ConnectMcpToolExecution {
    readonly taskSupport?: "forbidden" | "optional" | "required";
}
```

Declared in `packages/agent/dist/connect.d.ts`.

### `ConnectMcpToolIcon`

```ts
export interface ConnectMcpToolIcon {
    readonly src: string;
    readonly mimeType?: string;
    readonly sizes?: readonly string[];
    readonly theme?: "light" | "dark";
}
```

Declared in `packages/agent/dist/connect.d.ts`.

### `ConnectOptions`

```ts
export interface ConnectOptions extends ConnectRuntimeOptions {
    readonly sources: readonly ConnectSource[];
    readonly quality?: ConnectQualityPolicy;
    readonly toolName?: string;
}
```

Declared in `packages/agent/dist/connect.d.ts`.

### `ConnectProcessResult`

```ts
export interface ConnectProcessResult {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
}
```

Declared in `packages/agent/dist/connect.d.ts`.

### `ConnectQualityPolicy`

```ts
export interface ConnectQualityPolicy {
    /** Maximum records returned by one tool call across pages. */
    readonly maxRecords?: number;
    /** Maximum exact pages read by one tool call. */
    readonly maxPages?: number;
    /** Maximum serialized result bytes exposed to model. */
    readonly maxResultBytes?: number;
    /** Default refuses completeness-dependent answers after any cap is reached. */
    readonly incomplete?: "refuse";
}
```

Declared in `packages/agent/dist/connect.d.ts`.

### `ConnectRuntimeOptions`

```ts
export interface ConnectRuntimeOptions {
    /** Absolute path preferred. Otherwise CAVE_CONNECT_BIN, then PATH is checked. */
    readonly binary?: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly execute?: ConnectExecutor;
    readonly maxCaptureBytes?: number;
    readonly timeoutMs?: number;
}
```

Declared in `packages/agent/dist/connect.d.ts`.

### `ConnectSource`

```ts
export interface ConnectSource {
    /** Short agent-facing name, for example "work-github". */
    readonly id: string;
    /** Caveman Connect provider slug. */
    readonly provider: string;
    /** Optional exact saved connection. Omit only when provider has exactly one active connection. */
    readonly connectionId?: string;
    /** Syncs agent may trigger. Empty/omitted means read existing records only. */
    readonly collect?: readonly string[];
    /** Record models agent may read. Empty/omitted means any model under this allowed connection. */
    readonly models?: readonly string[];
    /**
     * Curated provider actions agent may execute. Default none. A bare string
     * lets the model choose every argument; the object form fixes destination or
     * credential-shaped arguments in trusted config instead.
     */
    readonly actions?: readonly (string | ConnectAction)[];
}
```

Declared in `packages/agent/dist/connect.d.ts`.

### `ConnectToolRuntimeDefinition`

Serializable runtime marker. Contains source allowlists, never credentials.

```ts
export interface ConnectToolRuntimeDefinition {
    readonly kind: "caveman-connect";
    readonly sources: readonly NormalizedConnectSource[];
    readonly quality: NormalizedConnectQualityPolicy;
    readonly binary?: string;
    readonly timeoutMs: number;
    readonly maxCaptureBytes: number;
}
```

Declared in `packages/agent/dist/connect.d.ts`.

### `NormalizedConnectAction`

```ts
export interface NormalizedConnectAction {
    readonly name: string;
    readonly bind: Readonly<Record<string, ConnectActionBindValue>>;
}
```

Declared in `packages/agent/dist/connect.d.ts`.

### `NormalizedConnectQualityPolicy`

```ts
export interface NormalizedConnectQualityPolicy {
    readonly maxRecords: number;
    readonly maxPages: number;
    readonly maxResultBytes: number;
    readonly incomplete: "refuse";
}
```

Declared in `packages/agent/dist/connect.d.ts`.

### `NormalizedConnectSource`

```ts
export interface NormalizedConnectSource {
    readonly id: string;
    readonly provider: string;
    readonly connectionId?: string;
    readonly collect: readonly string[];
    readonly models: readonly string[];
    readonly actions: readonly NormalizedConnectAction[];
}
```

Declared in `packages/agent/dist/connect.d.ts`.

## Type aliases

### `ConnectActionBindValue`

Values trusted config may fix on an action. Must stay serializable.

```ts
export type ConnectActionBindValue = string | number | boolean | null;
```

Declared in `packages/agent/dist/connect.d.ts`.

### `ConnectExecutor`

```ts
export type ConnectExecutor = (binary: string, args: readonly string[], options: ConnectExecuteOptions) => Promise<ConnectProcessResult>;
```

Declared in `packages/agent/dist/connect.d.ts`.

## Functions

### `compareConnectEfficiency`

Fail-closed local comparison. Token reduction alone never passes: connected
run must preserve task success/quality, use complete data, and lower total
measured cost after retrieval, retries, and collection.

```ts
export declare function compareConnectEfficiency(baseline: ConnectEfficiencyRun, connected: ConnectEfficiencyRun, options?: {
    readonly maxQualityRegression?: number;
}): ConnectEfficiencyComparison;
```

Declared in `packages/agent/dist/connect.d.ts`.

### `connectEnvironment`

```ts
export declare function connectEnvironment(source?: NodeJS.ProcessEnv): Record<string, string>;
```

Declared in `packages/agent/dist/connect.d.ts`.

### `createConnect`

```ts
export declare function createConnect(options: ConnectOptions): ConnectIntegration;
```

Declared in `packages/agent/dist/connect.d.ts`.

### `executeConnectTool`

Kernel-owned execution for `ConnectToolRuntimeDefinition`; never runs arbitrary host closure.

```ts
export declare function executeConnectTool(runtime: ConnectToolRuntimeDefinition, params: unknown, signal?: AbortSignal): Promise<unknown>;
```

Declared in `packages/agent/dist/connect.d.ts`.

### `resolveConnectBinary`

```ts
export declare function resolveConnectBinary(options?: Pick<ConnectRuntimeOptions, "binary" | "environment">): Promise<string>;
```

Declared in `packages/agent/dist/connect.d.ts`.

