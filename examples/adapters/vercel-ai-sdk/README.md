# Vercel AI SDK adapter: procurement recommendation

Runnable `ai@7.0.84` `ToolLoopAgent` using
`@caveman-ai/adapter-vercel-ai-sdk` as one native middleware/callback layer.
Vercel retains its loop, model transport, streaming, abort, and tool behavior.

Workflow returns an evidence-only recommendation with
`executionStatus: "not_executed"`. Supplied evidence is allowlisted exactly;
invented evidence fails. No action executor, approval queue, role gate, or
permission system exists.

## Deterministic proof

```bash
npm install --ignore-scripts
npm test
```

Tests instantiate pinned `ToolLoopAgent` with public `MockLanguageModelV4` and
prove request transformation, lifecycle order, canonical nullable usage, abort,
and native result handling without network. This is candidate evidence, not
external certification.

## Live smoke through Vercel AI Gateway

```bash
export AI_GATEWAY_API_KEY=...
npm run live
```

Optional `VERCEL_ADAPTER_SAMPLE_MODEL` selects gateway model. Default:
`anthropic/claude-haiku-4-5`. Missing credential prints explicit skip.

## Contract limits

- Manifest capabilities remain `experimental`, never locally certified.
- Adapter adds zero model calls and zero proxy hops.
- Unsupported replay, durability, tracing, and compilation remain host-owned.
- Workflow emits recommendation only; no external state changes.
