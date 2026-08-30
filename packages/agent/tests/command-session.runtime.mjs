import assert from "node:assert/strict";
import test from "node:test";

test("command-session package subpath exposes only the standalone runtime", async () => {
  const entry = await import("@caveman-ai/agent/command-session");
  assert.deepEqual(Object.keys(entry), ["createCommandSessionRuntime"]);
  const runtime = entry.createCommandSessionRuntime();
  await runtime.close();
  await assert.rejects(
    () => runtime.start({
      command: process.execPath,
      cwd: process.cwd(),
      env: {},
      timeoutMs: 1_000,
    }),
    /command_session_runtime_closed/,
  );
});
