import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AGENT_PLUGINS_SCHEMA,
  loadAgentEnvironment,
} from "../dist/agent-environment.js";

test("agent environment can disable every implicit workspace source", async () => {
  const root = await mkdtemp(join(tmpdir(), "cave-agent-environment-off-"));
  const home = join(root, "home");
  const skill = join(root, ".agents", "skills", "hidden");
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(skill, { recursive: true }),
  ]);
  try {
    await Promise.all([
      writeFile(join(root, "plugin.json"), JSON.stringify({
        $schema: AGENT_PLUGINS_SCHEMA,
        name: "workspace-plugin",
        version: "1.0.0",
      })),
      writeFile(join(skill, "SKILL.md"), [
        "---",
        "name: hidden",
        "description: Hidden workspace skill.",
        "---",
        "",
        "# Hidden",
      ].join("\n")),
    ]);

    const discovered = await loadAgentEnvironment({ cwd: root, homeDir: home });
    assert.equal(discovered.skills.length, 1);
    assert.equal(discovered.plugins.length, 1);

    const disabled = await loadAgentEnvironment({
      cwd: root,
      homeDir: home,
      includeDefaultRoots: false,
      includeWorkspacePlugin: false,
    });
    assert.deepEqual(disabled.skills, []);
    assert.deepEqual(disabled.commands, []);
    assert.deepEqual(disabled.plugins, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
