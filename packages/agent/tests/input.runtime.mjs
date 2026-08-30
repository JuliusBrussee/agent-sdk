import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_INPUT_MAX_BASE64_BYTES_PER_PART,
  AGENT_INPUT_MAX_PARTS,
  AGENT_INPUT_MAX_TEXT_BYTES,
  defineAgentInputEncoder,
  encodeAgentInput,
  normalizeAgentInput,
} from "../dist/input.js";

test("string input normalizes to one immutable text part", () => {
  const normalized = normalizeAgentInput("hello 🪨");
  assert.deepEqual(normalized, {
    parts: [{ type: "text", text: "hello 🪨" }],
    textBytes: new TextEncoder().encode("hello 🪨").byteLength,
    base64Bytes: 0,
    remoteReferences: 0,
  });
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.parts), true);
  assert.equal(Object.isFrozen(normalized.parts[0]), true);
});

test("multimodal normalization copies URL/base64 sources and records bounded totals", () => {
  const urlSource = { type: "url", url: "https://example.com/image.png?x=1" };
  const file = {
    type: "file",
    mimeType: "application/pdf",
    name: "report.pdf",
    source: { type: "base64", data: "TQ==" },
  };
  const opaqueValue = { vendorType: "thinking", data: { level: 2 } };
  const normalized = normalizeAgentInput([
    { type: "image", mimeType: "image/png", source: urlSource },
    { type: "audio", mimeType: "audio/wav", source: { type: "base64", data: "TWE=" } },
    file,
    { type: "opaque", provider: "openai", value: opaqueValue },
  ]);
  urlSource.url = "https://attacker.invalid/changed";
  file.name = "changed.pdf";
  file.source.data = "AAAA";
  opaqueValue.data.level = 99;

  assert.equal(normalized.remoteReferences, 1);
  assert.equal(normalized.base64Bytes, 3);
  assert.equal(normalized.parts[0].source.url, "https://example.com/image.png?x=1");
  assert.equal(normalized.parts[2].name, "report.pdf");
  assert.equal(normalized.parts[2].source.data, "TQ==");
  assert.deepEqual(normalized.parts[3], {
    type: "opaque",
    provider: "openai",
    value: { vendorType: "thinking", data: { level: 2 } },
  });
  assert.equal(Object.isFrozen(normalized.parts[3].value.data), true);
  assert.equal(Object.isFrozen(normalized.parts[0].source), true);
});

test("input objects and sources are exact and reject hidden accessors", () => {
  assert.throws(
    () => normalizeAgentInput([{ type: "text", text: "hello", permission: "ask" }]),
    /cave_input_part_invalid:0/,
  );
  assert.throws(
    () => normalizeAgentInput([{
      type: "image",
      mimeType: "image/png",
      source: { type: "url", url: "https://example.com/a.png", headers: {} },
    }]),
    /cave_input_source_invalid:0/,
  );
  const accessor = { type: "text" };
  Object.defineProperty(accessor, "text", { enumerable: true, get: () => "hidden" });
  assert.throws(() => normalizeAgentInput([accessor]), /cave_input_part_invalid:0/);
  assert.throws(() => normalizeAgentInput([]), /cave_input_parts_invalid/);
  assert.throws(() => normalizeAgentInput(new Array(1)), /cave_input_parts_invalid/);
  assert.throws(
    () => normalizeAgentInput(Array.from(
      { length: AGENT_INPUT_MAX_PARTS + 1 },
      () => ({ type: "text", text: "x" }),
    )),
    /cave_input_parts_invalid/,
  );
  assert.throws(
    () => normalizeAgentInput([{
      type: "opaque",
      provider: "bad provider",
      value: null,
    }]),
    /cave_input_part_invalid:0/,
  );
  assert.throws(
    () => normalizeAgentInput([{
      type: "opaque",
      provider: "openai",
      value: { invalid: () => "not JSON" },
    }]),
    /cave_finite_json_non_json/,
  );
});

test("MIME, filename, remote URL, and canonical base64 validation fail closed", () => {
  const image = (source, mimeType = "image/png") => ({ type: "image", mimeType, source });
  for (const url of [
    "file:///tmp/private",
    "data:image/png;base64,TQ==",
    "ftp://example.com/image.png",
    "https://user:secret@example.com/image.png",
    " https://example.com/image.png",
  ]) {
    assert.throws(() => normalizeAgentInput([image({ type: "url", url })]), /url_invalid/);
  }
  assert.throws(() => normalizeAgentInput([image({ type: "url", url: "https://example.com" }, "text/plain")]), /part_invalid/);
  assert.throws(() => normalizeAgentInput([image({ type: "base64", data: "TQ" })]), /base64_invalid/);
  assert.throws(() => normalizeAgentInput([image({ type: "base64", data: "TR==" })]), /base64_invalid/);
  assert.throws(() => normalizeAgentInput([image({ type: "base64", data: "TWF=" })]), /base64_invalid/);
  assert.throws(() => normalizeAgentInput([image({ type: "base64", data: "" })]), /base64_empty:0/);
  assert.throws(
    () => normalizeAgentInput([{
      type: "audio",
      mimeType: "audio/wav",
      source: { type: "base64", data: "" },
    }]),
    /base64_empty:0/,
  );
  assert.equal(normalizeAgentInput([{
    type: "file",
    mimeType: "application/octet-stream",
    source: { type: "base64", data: "" },
  }]).base64Bytes, 0);
  assert.throws(
    () => normalizeAgentInput([{
      type: "file",
      mimeType: "application/octet-stream",
      name: "../secret",
      source: { type: "base64", data: "" },
    }]),
    /file_name_invalid/,
  );
});

test("input byte ceilings apply before encoder execution", () => {
  assert.throws(
    () => normalizeAgentInput("x".repeat(AGENT_INPUT_MAX_TEXT_BYTES + 1)),
    /cave_input_text_bytes_limit/,
  );
  const atMostLimit = "AAAA".repeat(Math.floor(AGENT_INPUT_MAX_BASE64_BYTES_PER_PART / 3));
  const overLimit = `${atMostLimit}AAAA`;
  assert.throws(
    () => normalizeAgentInput([{
      type: "file",
      mimeType: "application/octet-stream",
      source: { type: "base64", data: overLimit },
    }]),
    /cave_input_base64_part_bytes_limit/,
  );
});

test("encoder preflights every part and never encodes a partially supported input", async () => {
  const checked = [];
  let encoded = false;
  const encoder = defineAgentInputEncoder({
    id: "text-only.v1",
    supports(part) {
      checked.push(part.type);
      return part.type === "text";
    },
    encode() {
      encoded = true;
      return "unexpected";
    },
  });
  await assert.rejects(
    encodeAgentInput([
      { type: "text", text: "hello" },
      { type: "image", mimeType: "image/png", source: { type: "url", url: "https://example.com/a.png" } },
      { type: "file", mimeType: "text/plain", source: { type: "base64", data: "TQ==" } },
    ], encoder),
    /cave_input_unsupported:text-only.v1:1,2/,
  );
  assert.deepEqual(checked, ["text", "image", "file"]);
  assert.equal(encoded, false);
});

test("selected encoder receives one normalized snapshot and exact abort signal without SDK fetching URLs", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    throw new Error("SDK must not fetch");
  };
  const controller = new AbortController();
  let seenInput;
  let seenSignal;
  try {
    const output = await encodeAgentInput([{
      type: "image",
      mimeType: "image/png",
      source: { type: "url", url: "https://example.com/a.png" },
    }], {
      id: "reference.v1",
      supports: () => true,
      encode(input, signal) {
        seenInput = input;
        seenSignal = signal;
        return input.parts[0].source.url;
      },
    }, controller.signal);
    assert.equal(output, "https://example.com/a.png");
    assert.equal(fetchCalls, 0);
    assert.equal(Object.isFrozen(seenInput), true);
    assert.equal(seenSignal, controller.signal);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("encoder definition snapshots functions, rejects unknown fields, and validates support result", async () => {
  const source = {
    id: "snapshot.v1",
    supports: () => true,
    encode: () => "first",
  };
  const encoder = defineAgentInputEncoder(source);
  source.encode = () => "changed";
  assert.equal(await encodeAgentInput("hello", encoder), "first");
  assert.throws(
    () => defineAgentInputEncoder({ ...source, approval: "ask" }),
    /cave_input_encoder_invalid/,
  );
  await assert.rejects(
    encodeAgentInput("hello", { id: "bad-support.v1", supports: () => "yes", encode: () => "no" }),
    (error) => error instanceof AggregateError &&
      /cave_input_encoder_support_invalid:0/.test(String(error.errors[0])),
  );
});

test("support hook failures still preflight later parts and never call encode", async () => {
  const checked = [];
  let encoded = false;
  await assert.rejects(
    encodeAgentInput([
      { type: "text", text: "one" },
      { type: "text", text: "two" },
    ], {
      id: "throwing-support.v1",
      supports(part) {
        checked.push(part.text);
        if (part.text === "one") throw new Error("support crashed");
        return true;
      },
      encode() {
        encoded = true;
      },
    }),
    (error) => error instanceof AggregateError && error.errors[0].message === "support crashed",
  );
  assert.deepEqual(checked, ["one", "two"]);
  assert.equal(encoded, false);
});

test("input encoding observes abort before and after encoder execution", async () => {
  const reason = new Error("cancel input");
  await assert.rejects(
    encodeAgentInput("hello", {
      id: "never.v1",
      supports: () => true,
      encode: () => "never",
    }, AbortSignal.abort(reason)),
    (error) => error === reason,
  );

  const controller = new AbortController();
  await assert.rejects(
    encodeAgentInput("hello", {
      id: "during.v1",
      supports: () => true,
      encode(_input, signal) {
        assert.equal(signal, controller.signal);
        controller.abort(reason);
        return "late";
      },
    }, controller.signal),
    (error) => error === reason,
  );

  const pendingController = new AbortController();
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const pending = encodeAgentInput("hello", {
    id: "pending.v1",
    supports: () => true,
    encode() {
      entered();
      return new Promise(() => {});
    },
  }, pendingController.signal);
  await started;
  pendingController.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
});

test("input fields must be own data properties despite prototype pollution", () => {
  const previousType = Object.getOwnPropertyDescriptor(Object.prototype, "type");
  const previousText = Object.getOwnPropertyDescriptor(Object.prototype, "text");
  Object.defineProperty(Object.prototype, "type", {
    configurable: true,
    enumerable: false,
    value: "text",
  });
  Object.defineProperty(Object.prototype, "text", {
    configurable: true,
    enumerable: false,
    value: "inherited",
  });
  try {
    assert.throws(() => normalizeAgentInput([{}]), /cave_input_part_invalid:0/);
  } finally {
    if (previousType === undefined) delete Object.prototype.type;
    else Object.defineProperty(Object.prototype, "type", previousType);
    if (previousText === undefined) delete Object.prototype.text;
    else Object.defineProperty(Object.prototype, "text", previousText);
  }
});
