# The agent directory

The filesystem-first authoring convention. One directory composes into one
ordinary `agent()` call — the loader is sugar over the same primitives, not a
second runtime.

```text
support-bot/
├── instructions.md          required — the agent's standing prose
├── agent.ts                 required — default-exports an AgentDirConfig
├── skills/
│   ├── refund-policy.md
│   └── shipping-claims.md
├── tools/
│   └── lookup_order.ts
├── subagents/
│   └── researcher/          same layout, recursively
└── evals/
    └── support.eval.ts
```

```ts
import { loadAgentDir, run } from "@caveman-ai/agent";

const support = await loadAgentDir("./support-bot");
const result = await run(support, "Where is order A-123?");
```

## Detection and identity

A directory follows the convention when `instructions.md` exists
(`hasAgentDirConvention`). `agent.ts` is then required too; both missing-file
errors name the exact fix.

The agent id is the directory basename, slugified: lowercased, invalid
characters become `-`, repeats collapse, leading and trailing `-` are trimmed. A
name that cannot slug to a valid id fails closed with both the name and the slug
in the message.

## `agent.ts`

```ts
import type { AgentDirConfig } from "@caveman-ai/agent";

export default {
  model: "anthropic/claude-sonnet-4-6",
  budget: { maxTokens: 120_000, onExhausted: "compact" },
  breakers: { repeatedCall: 3 },
  context: {
    tier: "enterprise",
    today: { value: () => new Date().toDateString(), stability: "turn" },
  },
} satisfies AgentDirConfig;
```

| Key | Type | Notes |
| --- | --- | --- |
| `model` | `AgentDefinition["model"]` | Required |
| `budget` | `RunBudget` | Run default; explicit `RunOptions.budget` overrides |
| `breakers` | `RunBreakers` | Run default; explicit `RunOptions.breakers` override |
| `context` | `Record<string, AgentDirContextValue>` | Extra prefix segments, lowered through `context()` |

Unknown keys fail closed.

### Context stability

A context entry is either a bare value/function or `{ value, stability }`.

- `stability: "build"` (**the default**) puts the segment in the frozen prefix.
- `stability: "turn"` puts it in the live zone.

Either way the value is evaluated **once**, at directory load. `"turn"` does not
re-evaluate per turn today; it only decides which cache region the segment sits
in. The `"build"` default is load-bearing: it is what lets the build's
volatile-prefix check catch a run-varying value whose author forgot to declare
`stability: "turn"`.

## `tools/*.ts`

One tool per file, default-exported, and **the filename is the tool name**. A
mismatch between the filename and the declared `name` fails closed. See
[Tools](04-tools.md).

## `skills/*.md`

Each skill is markdown with a terminated frontmatter block:

```markdown
---
name: refund-policy
description: When and how refunds are issued.
---

Full policy text, loaded only when the skill is invoked.
```

`name` must equal the filename minus `.md`. Descriptions are lowered into one
`agent.skills` index segment that enters stable context; bodies stay on disk
until the framework `cave_skill` tool serves them. Adding a large skill
therefore does not expand every request. A directory with no `skills/*.md` gets
no `cave_skill` tool at all.

## `subagents/<name>/`

Each subdirectory is a full agent directory, loaded recursively and attached as
a `subagent()` tool named after the directory.

## Run defaults

`agentDirRunDefaults(definition)` exposes what the directory contributes:

| Default | Source |
| --- | --- |
| `rootDir` | The directory |
| `entryPath` | `.caveman/agent-dir-entry.mjs`, generated so sandboxed runs stage a complete source graph from static imports |
| `budget`, `breakers` | `agent.ts` |
| `printReceipt` | Defaults **on** for directory-loaded runs, off everywhere else |

Receipt printing defaults on here and off elsewhere because stdout may be a
protocol channel that a receipt would corrupt.

## Diagnostics helpers

| Function | Returns |
| --- | --- |
| `agentDirSkills(definition)` | Skill bodies by name, sorted; `undefined` when the directory has none |
| `agentDirContextOrigins(definition)` | Which `agent.ts` entry declared each context segment, so the volatile-prefix check can name the offending line |
| `composeAgentDir(...)` | The composition step, for tooling that already holds the parts |
| `AGENT_DIR_ENTRY` | The generated entry path constant |

## CLI interaction

Bare `caveman-agent dev` and `caveman-agent serve .` prefer the directory
convention when `instructions.md` is present, and fall back to
`src/agent.ts` otherwise.
