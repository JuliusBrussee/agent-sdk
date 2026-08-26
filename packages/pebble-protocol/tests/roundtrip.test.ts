import test from "node:test";
import assert from "node:assert/strict";

import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { encodeFrameText, decodeFrames } from "../src/framing.ts";
import { ALL_EVENT_KINDS, isTurnEvent } from "../src/events.ts";

const fixturesDir = new URL("../fixtures/", import.meta.url);

test("fixtures directory covers every event kind exactly once", async () => {
  const files = (await readdir(fixturesDir)).sort();
  const expected = ALL_EVENT_KINDS.map((kind) => `${kind}.json`).sort();
  assert.deepEqual(files, expected);
});

test("every fixture round-trips encode → decode → validate → re-encode byte-stably", async () => {
  const files = await readdir(fixturesDir);
  assert.equal(files.length, ALL_EVENT_KINDS.length);

  for (const name of files) {
    const path = new URL(`../fixtures/${name}`, import.meta.url);
    const original = await readFile(fileURLToPath(path));

    // Fixture hygiene: one line, canonical compact JSON, trailing newline.
    assert.ok(original.at(-1) === 0x0a, `${name}: trailing newline`);
    assert.equal(
      original.includes(0x0a, 0),
      true,
      `${name}: at least the final newline`,
    );
    assert.ok(
      !original.subarray(0, -1).includes(0x0a),
      `${name}: single-line frame`,
    );

    // 1. decode
    const frames = decodeFrames(original);
    assert.equal(frames.length, 1, `${name}: exactly one frame`);

    // 2. validate against the frozen schema
    const event = frames[0];
    assert.ok(
      isTurnEvent(event),
      `${name}: must be a valid TurnEvent`,
    );
    assert.equal(
      event.kind + ".json",
      name,
      `${name}: filename matches event kind`,
    );

    // 3. re-encode byte-stably
    const once = Buffer.from(encodeFrameText(event));
    assert.ok(
      once.equals(original),
      `${name}: first-generation bytes differ`,
    );

    // 4. second generation: stability must hold through another cycle
    const again = Buffer.from(encodeFrameText(decodeFrames(once)[0]));
    assert.ok(
      again.equals(once),
      `${name}: second-generation bytes differ`,
    );

    // 5. semantic deep-equality with what's on disk
    assert.deepEqual(JSON.parse(once.toString("utf8")), JSON.parse(original.toString("utf8")));
  }
});

test("fixture stream is a coherent session: ascending seq over one sessionId", async () => {
  const events = [];
  for (const kind of ALL_EVENT_KINDS) {
    const raw = await readFile(fileURLToPath(new URL(`../fixtures/${kind}.json`, import.meta.url)));
    events.push(JSON.parse(raw.toString("utf8")));
  }
  const sessionIds = new Set(events.map((e) => e.sessionId));
  assert.equal(sessionIds.size, 1, "all fixtures share one sessionId");
  const seqs = [...events].map((e) => e.seq).sort((a, b) => a - b);
  for (let i = 0; i < seqs.length; i++) {
    assert.equal(seqs[i], i, `seq ${i} present exactly once`);
  }
});
