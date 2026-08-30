# Artifacts and files

Everything the SDK reads from or writes to a project directory.

## Project layout

```text
my-agent/
├── caveman.config.ts            defineBuild({ entry, evals, … })
├── instructions.md              agent-directory convention (optional)
├── agent.ts                     AgentDirConfig, or an agent() module
├── tools/*.ts                   one tool per file, filename = tool name
├── skills/*.md                  frontmatter + body
├── subagents/<name>/            nested agent directories
├── evals/*.eval.ts              declared fixtures
└── .caveman/                    generated — see below
```

## `.caveman/`

| Path | Written by | Contents |
| --- | --- | --- |
| `provider.json` | initializer / `dev` | Provider selection. Second step of `auto()` resolution |
| `agent.lock.json` | `build` | The Cave Build proof envelope. Parse with `parseAnyCaveBuildLock` |
| `workload-profile.json` | `build` | Content-blind workload profile and provenance |
| `build-report.json` | `build` | Search cost, holdout evidence, passes, claims, and a local `inferred` `break_even_tasks` point estimate (`null` unless total actual search cost is complete and the holdout catalog delta is positive) |
| `frozen-prefix.json` | `build` | Prefix baseline with its estimate `basis`, used by the shrink check. `--accept-prefix-shrink` resets it |
| `agent-dir-entry.mjs` | `loadAgentDir`, `dev` | Generated static-import module entry so required-sandbox staging reaches every convention file |
| `traces/*.jsonl` | you | Optional content-blind profile evidence (Caveman `RunResult`, OTel span, or OpenInference span) |
| `runs/<stamp>/receipt.json` | `run()` with `printReceipt` | The unmodified wire receipt for one run |
| `runs/durable/<runId>/` | durable runs | Append-only JSONL journal, `0700` directories / `0600` files, because it necessarily holds message content |

`.caveman/runs` is excluded from `dev`'s watch set — watching it would mark the
snapshot dirty after each turn's own receipt.

## Memory storage

Default root: `CAVE_AGENT_MEMORY_ROOT`, else `~/.caveman/agent-memory`.

Per-namespace private JSON, keyed by `(tenant, agentId, namespace)`. Directories
`0700`, files `0600`; writes use a private temp file plus atomic rename. Vectors
are normalized int8 + base64, not floating-point arrays. Corrupt state reads as
empty.

## The receipt

Serialized receipts carry `schema: caveman.agent.run-receipt.v1` and validate
against the shared contract schema `agent-run-receipt.schema.json`. Field
meanings: [Budgets, receipts, and breakers](../guides/09-budgets-receipts-breakers.md).

## Generated source that must not be hand-edited

| File | Regenerate with |
| --- | --- |
| `packages/agent/src/catalog.ts` | `node scripts/generate-agent-catalog.mjs` |
| `caveman-docs/reference/api/**` | `node scripts/generate-docs-api.mjs` |
| `caveman-docs/reference/identifiers.md` | `node scripts/generate-docs-api.mjs` |
| `packages/pebble-protocol/fixtures/*` | `scripts/regenerate-fixtures.mjs` (in that package) |

`npm run check:catalog` fails until the catalog generator is re-run after a
catalog edit. `CATALOG_SHA256` is the SHA-256 of those exact catalog bytes and is
stamped into lock evidence.

## Trace row envelope

```json
{"schema_version":1,"case_id":"case-a","lineage_id":"family-a","input_sha256":"0123…","agent_sha256":"abcd…","trace":{"traceId":"…","spanId":"…","attributes":{}}}
```

Raw prompt and result span attributes are refused. Generic OTel and OpenInference
spans always stay unpriced; only strict Caveman evidence can be repriced from the
pinned public catalog.

## Hosting files

Shipped inside the `@caveman-ai/agent` tarball under `hosting/`:

| File | Purpose |
| --- | --- |
| `hosting/Dockerfile` | The container image |
| `hosting/README.md` | Deployment contract |
| `hosting/cloudflare/*` | Worker + Container + Durable-Object journal recipe |
