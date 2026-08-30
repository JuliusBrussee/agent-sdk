# Top-five candidate conformance

`run-candidates.mjs` executes the canonical v4 vectors against the exact
experimental capability set declared by Vercel AI SDK, LangGraph, OpenAI
Agents JS, Cloudflare Agents, and Mastra. Fixtures call only local native hooks
and synthetic providers: they make zero external model calls and add zero proxy
hops.

Reports are candidate evidence, never certification. A skipped vector or
benchmark blocks that capability. This is intentional for partial native seams
such as Vercel and Mastra run-error observation, Mastra stream-source errors,
and asynchronous hooks that the synchronous suite benchmark cannot measure.
Upstream runners, retries, tools, streams, durable state, and tracing remain
host-owned exactly as their manifests state.

Generate report JSON for review:

```bash
node packages/adapters/vercel-ai-sdk/conformance/run-candidates.mjs --print vercel-ai-sdk
```

Repack the exact installed adapter/upstream sources, rerun cases and suite-owned
performance measurements, validate report self-digests, compare deterministic
evidence and artifact digests, and enforce the 25 KiB adapter budget:

```bash
node packages/adapters/vercel-ai-sdk/conformance/run-candidates.mjs --check
```

The checked report retains the generation host/runtime and measured p99.
Reproduction compares all semantic output and performance status while omitting
only the environment-dependent p99 observation itself.
