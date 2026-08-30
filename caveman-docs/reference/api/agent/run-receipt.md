# `@caveman-ai/agent/run-receipt`

> Generated from the built type declarations by `node scripts/generate-docs-api.mjs`.
> Do not edit by hand. Version at generation time: `0.2.0`.

Declaration file: `packages/agent/dist/run-receipt.d.ts`.

<details><summary>Symbol index</summary>

- **Function**: `defineRunReceipt`
- **Variable**: `AGENT_RUN_RECEIPT_SCHEMA`, `validateRunReceipt`

</details>

## Functions

### `defineRunReceipt`

Validate one complete receipt, detach every nested value, and deeply freeze
the result. This is the sole public receipt parser; it accepts both JSON wire
objects (optional `undefined` fields absent) and SDK in-memory receipts.

```ts
export declare function defineRunReceipt(value: unknown): RunReceipt;
```

Declared in `packages/agent/dist/run-receipt.d.ts`.

## Variables & constants

### `AGENT_RUN_RECEIPT_SCHEMA`

Versioned cross-package wire identity for an SDK economic receipt.

```ts
export declare const AGENT_RUN_RECEIPT_SCHEMA: "caveman.agent.run-receipt.v1";
```

Declared in `packages/agent/dist/run-receipt.d.ts`.

### `validateRunReceipt`

Alias: validation and definition share one strict parser, never two rulesets.

```ts
export declare const validateRunReceipt: typeof defineRunReceipt;
```

Declared in `packages/agent/dist/run-receipt.d.ts`.

