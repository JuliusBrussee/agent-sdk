import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
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

test("one literal query read scans buffered output and waits across future chunks", async () => {
  const entry = await import("@caveman-ai/agent/command-session");
  const runtime = entry.createCommandSessionRuntime({
    maxOutputBytes: 1_024,
    maxReadBytes: 128,
    maxTimeoutMs: 5_000,
    maxWaitMs: 2_000,
  });
  const prefix = "pre-buffered-without-match:";
  try {
    const started = await runtime.start({
      command: process.execPath,
      args: [
        "-e",
        [
          `process.stdout.write(${JSON.stringify(prefix)});`,
          "let input='';let step=0;",
          "process.stdin.setEncoding('utf8');",
          "process.stdin.on('data',chunk=>{input+=chunk;let newline;",
          "while((newline=input.indexOf('\\n'))>=0){input=input.slice(newline+1);step++;",
          "if(step===1)process.stdout.write('TAR');",
          "if(step===2)process.stdout.write('G');",
          "if(step===3)process.stdout.write('ET-tail',()=>process.exit(0));",
          "}});",
        ].join(""),
      ],
      cwd: process.cwd(),
      env: {},
      timeoutMs: 5_000,
    });
    const buffered = await runtime.read({
      sessionId: started.sessionId,
      cursor: 0,
      limit: prefix.length,
      waitMs: 1_000,
    });
    assert.equal(buffered.output, prefix);

    const pending = runtime.read({
      sessionId: started.sessionId,
      cursor: 0,
      query: "TARGET",
      limit: 128,
      waitMs: 2_000,
    });
    for (const [input, availableTo] of [
      ["one\n", prefix.length + 3],
      ["two\n", prefix.length + 4],
      ["three\n", prefix.length + 11],
    ]) {
      const written = await runtime.write({ sessionId: started.sessionId, input });
      assert.equal(written.accepted, true);
      const deadline = Date.now() + 1_000;
      while (runtime.list()[0]?.availableTo !== availableTo) {
        assert.ok(Date.now() < deadline, "child output did not reach expected chunk boundary");
        await delay(5);
      }
    }

    const found = await pending;
    assert.equal(found.cursor, 0);
    assert.equal(found.matchStart, prefix.length);
    assert.equal(found.outputStart, prefix.length);
    assert.match(found.output, /^TARGET-tail/);

    const terminal = await runtime.read({
      sessionId: started.sessionId,
      cursor: found.nextCursor,
      query: "never-arrives",
      waitMs: 2_000,
    });
    assert.equal(terminal.state, "exited");
    assert.equal(terminal.matchStart, null);
  } finally {
    await runtime.close();
  }
});
