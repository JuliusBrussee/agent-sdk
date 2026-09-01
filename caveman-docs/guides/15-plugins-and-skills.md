# Plugins and skills

The core runtime accepts explicit instructions, contexts, tools, and definition
transforms. **It never searches for repository files.** Products that want
coding-agent interoperability opt in through `@caveman-ai/agent/plugins`.

```ts
import { agent } from "@caveman-ai/agent";
import {
  applyAgentEnvironment,
  createAgentEnvironmentTransform,
  expandAgentEnvironmentSlashCommand,
  loadAgentEnvironment,
} from "@caveman-ai/agent/plugins";

const environment = await loadAgentEnvironment({ cwd: process.cwd() });

const reviewer = applyAgentEnvironment(agent({
  id: "reviewer",
  instructions: "Review requested changes.",
  model: "openai/gpt-5.4",
  sandbox: "host",
}), environment);

const prompt = expandAgentEnvironmentSlashCommand(
  "/vercel-plugin:deploy preview",
  environment,
);
```

## What is discovered

| Root | Contents |
| --- | --- |
| `<project>/.agents/skills/<name>/SKILL.md` | Project skills |
| `~/.agents/skills/<name>/SKILL.md` | User skills |
| `<project>/.agents/plugins/<plugin>/` | Project plugin packages |
| `~/.agents/plugins/<plugin>/` | User plugin packages |

Four manifest layouts are accepted, in this precedence:

| Path | Format |
| --- | --- |
| `plugin.json` | `agent-plugins-v1` |
| `.plugin/plugin.json` | `open-plugin` (Vercel OpenPlugin) |
| `.claude-plugin/plugin.json` | `claude-code` compatibility |
| `.cursor-plugin/plugin.json` | `cursor` compatibility |

### `loadAgentEnvironment` options

| Option | Default | Notes |
| --- | --- | --- |
| `cwd` | `process.cwd()` | Where the workspace search starts |
| `homeDir` | `os.homedir()` | Overridable for tests and sandboxes |
| `skillRoots` | — | Extra roots, **highest precedence first** |
| `pluginRoots` | — | Exact plugin package roots, highest precedence first |
| `pluginCollections` | — | Directories whose immediate children may be plugin package roots |
| `includeDefaultRoots` | `true` | Set `false` for a fully explicit product wrapper |
| `includeWorkspacePlugin` | `true` | Auto-detect a plugin manifest at `cwd` |

The returned `AgentEnvironment` carries `cwd`, `workspaceRoot`, `skills`,
`commands`, `plugins`, and `diagnostics`. Diagnostics are how the loader reports
what it ignored (unknown manifest fields, non-object extensions, …) instead of
failing the whole load.

## What enters the prompt

Metadata enters the stable prefix as two context segments
(`AGENT_SKILLS_CONTEXT_ID`, `AGENT_PLUGIN_COMMANDS_CONTEXT_ID`). The full
`SKILL.md`, its contained resources, and markdown command bodies enter model
context **only after activation**. Adding a large skill therefore does not
expand every request.

Plugin skills and commands use qualified ids: `vercel-plugin:nextjs`,
`vercel-plugin:deploy`.

## Slash commands

```ts
expandAgentEnvironmentSlashCommand("/vercel-plugin:deploy preview", environment);
```

`$ARGUMENTS` and `$1` … `$9` expand for plugin commands.

## Wiring it into a coding product

```ts
const coding = createCodingAgent({
  workspace: process.cwd(),
  toolMode: "programmatic",
  definitionTransforms: [createAgentEnvironmentTransform(environment)],
});
```

Programmatic mode then nests loader behavior behind its one composite tool
without making workspace discovery a core runtime concern.

## The hard limit: declarative only

Agent Plugins v1 and OpenPlugin support implements **declarative skills and
markdown commands only**.

| Present in a manifest | What happens |
| --- | --- |
| `mcp.json` / `.mcp.json` | Recognized and **reported**, never launched |
| Hooks | Recognized and reported, never executed |
| Custom agents | Recognized and reported, never launched |
| Plugin subprocesses | Never spawned |
| Ambient secrets | Never inherited |

Executable integrations stay host-owned and need separate environment-allowlist
and lifecycle contracts.

## One implementation, one place

All of this lives in `packages/agent/src/agent-environment.ts`. Product wrappers
may add search roots, but must not fork validation, containment, precedence, or
invocation. That rule is non-negotiable in this repository.

## Lower-level helpers

| Function | Use |
| --- | --- |
| `findAgentWorkspaceRoot` | Locate the workspace root from a cwd |
| `loadAgentSkillDirectory` | Load one skill root |
| `parseAgentSkill` | Parse a single `SKILL.md` |
| `readAgentSkillResource` | Read a contained resource (defaults to `SKILL.md`) |
| `loadAgentPlugin` | Load one plugin package |
| `renderAgentSkillsIndex` / `renderAgentPluginCommandsIndex` | Render the prefix segments |
| `renderAgentSkillInvocation` / `renderAgentPluginCommandInvocation` | Render an activation body |
| `AGENT_PLUGINS_SCHEMA` | The manifest schema constant |

## Agent-directory projects

Agent-directory projects use same canonical loader. Put project skills under
`.agents/skills/<name>/SKILL.md`; `loadAgentDir()` adds that explicit project
root while leaving user-home and plugin discovery disabled. No second parser,
registry, or skill tool exists.

Full API: [`@caveman-ai/agent/plugins`](../reference/api/agent/plugins.md).
