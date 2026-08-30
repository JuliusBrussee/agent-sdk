# `@caveman-ai/agent/model-boundary`

> Generated from the built type declarations by `node scripts/generate-docs-api.mjs`.
> Do not edit by hand. Version at generation time: `0.2.0`.

Declaration file: `packages/agent/dist/model-boundary.d.ts`.

<details><summary>Symbol index</summary>

- **Interface**: `CapturedModelBoundary`, `CapturedModelBoundaryCall`, `ModelBoundary`, `ModelBoundaryContext`, `ModelBoundaryFailed`, `ModelBoundaryMiddleware`, `ModelBoundaryPrepare`, `ModelBoundarySettled`, `PreparedModelBoundaryCall`
- **Type alias**: `ModelBoundaryRole`
- **Function**: `captureModelBoundary`, `createModelBoundary`
- **Variable**: `MODEL_BOUNDARY_MAX_CONTEXT_STRING_LENGTH`, `MODEL_BOUNDARY_MAX_ID_LENGTH`, `MODEL_BOUNDARY_MAX_MIDDLEWARE`

</details>

## Interfaces

### `CapturedModelBoundary`

Host-side, hostile-safe view of one configured model boundary.

```ts
export interface CapturedModelBoundary<Request, Response> {
    prepare(request: Request, context: ModelBoundaryContext): Promise<CapturedModelBoundaryCall<Request, Response>>;
}
```

Declared in `packages/agent/dist/model-boundary.d.ts`.

### `CapturedModelBoundaryCall`

A prepared call whose terminal observer is diagnostic-only and can fire at
most once. The host retains provider I/O and native result ownership.

```ts
export interface CapturedModelBoundaryCall<Request, Response> {
    readonly request: Request;
    settled(response: Response): void;
    failed(error: unknown): void;
}
```

Declared in `packages/agent/dist/model-boundary.d.ts`.

### `ModelBoundary`

```ts
export interface ModelBoundary<Request, Response> {
    readonly middlewareIds: readonly string[];
    prepare(request: Request, context: ModelBoundaryContext): Promise<PreparedModelBoundaryCall<Request, Response>>;
}
```

Declared in `packages/agent/dist/model-boundary.d.ts`.

### `ModelBoundaryContext`

```ts
export interface ModelBoundaryContext {
    readonly identity: AdapterLifecycleIdentity & {
        readonly modelCallId: string;
    };
    readonly role: ModelBoundaryRole;
    readonly provider: string;
    readonly model: string;
    readonly signal: AbortSignal;
}
```

Declared in `packages/agent/dist/model-boundary.d.ts`.

### `ModelBoundaryFailed`

```ts
export interface ModelBoundaryFailed<Request> {
    readonly request: Request;
    readonly error: unknown;
    readonly context: ModelBoundaryContext;
}
```

Declared in `packages/agent/dist/model-boundary.d.ts`.

### `ModelBoundaryMiddleware`

Model middleware transforms a request before provider I/O and observes one
terminal outcome. It deliberately receives no `next` callback or provider
function: only the owning runtime may perform model I/O.

```ts
export interface ModelBoundaryMiddleware<Request, Response> {
    readonly id: string;
    readonly prepare?: (input: ModelBoundaryPrepare<Request>) => Request | undefined | Promise<Request | undefined>;
    readonly settled?: (input: ModelBoundarySettled<Request, Response>) => void | Promise<void>;
    readonly failed?: (input: ModelBoundaryFailed<Request>) => void | Promise<void>;
}
```

Declared in `packages/agent/dist/model-boundary.d.ts`.

### `ModelBoundaryPrepare`

```ts
export interface ModelBoundaryPrepare<Request> {
    readonly request: Request;
    readonly context: ModelBoundaryContext;
}
```

Declared in `packages/agent/dist/model-boundary.d.ts`.

### `ModelBoundarySettled`

```ts
export interface ModelBoundarySettled<Request, Response> {
    readonly request: Request;
    readonly response: Response;
    readonly context: ModelBoundaryContext;
}
```

Declared in `packages/agent/dist/model-boundary.d.ts`.

### `PreparedModelBoundaryCall`

```ts
export interface PreparedModelBoundaryCall<Request, Response> {
    readonly request: Request;
    readonly context: ModelBoundaryContext;
    /** Best-effort observation; always returns the native response unchanged. */
    settled(response: Response): Promise<Response>;
    /** Best-effort observation; always throws the exact native failure. */
    failed(error: unknown): Promise<never>;
}
```

Declared in `packages/agent/dist/model-boundary.d.ts`.

## Type aliases

### `ModelBoundaryRole`

```ts
export type ModelBoundaryRole = "working" | "compaction";
```

Declared in `packages/agent/dist/model-boundary.d.ts`.

## Functions

### `captureModelBoundary`

Capture an optional boundary once at an adapter trust boundary.

Only own data properties are accepted, so inherited methods and accessors
never execute. The boundary and prepared-call receivers are preserved while
terminal observation stays best-effort and exactly-once.

```ts
export declare function captureModelBoundary<Request, Response>(value: ModelBoundary<Request, Response> | undefined): CapturedModelBoundary<Request, Response> | undefined;
```

Declared in `packages/agent/dist/model-boundary.d.ts`.

### `createModelBoundary`

```ts
export declare function createModelBoundary<Request, Response>(middleware: readonly ModelBoundaryMiddleware<Request, Response>[]): ModelBoundary<Request, Response>;
```

Declared in `packages/agent/dist/model-boundary.d.ts`.

## Variables & constants

### `MODEL_BOUNDARY_MAX_CONTEXT_STRING_LENGTH`

```ts
export declare const MODEL_BOUNDARY_MAX_CONTEXT_STRING_LENGTH = 512;
```

Declared in `packages/agent/dist/model-boundary.d.ts`.

### `MODEL_BOUNDARY_MAX_ID_LENGTH`

```ts
export declare const MODEL_BOUNDARY_MAX_ID_LENGTH = 64;
```

Declared in `packages/agent/dist/model-boundary.d.ts`.

### `MODEL_BOUNDARY_MAX_MIDDLEWARE`

```ts
export declare const MODEL_BOUNDARY_MAX_MIDDLEWARE = 64;
```

Declared in `packages/agent/dist/model-boundary.d.ts`.

