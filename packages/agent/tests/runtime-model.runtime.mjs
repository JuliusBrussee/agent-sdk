import assert from "node:assert/strict";
import test from "node:test";

import {
  PRICE_PROVENANCE_SHA256,
} from "../dist/catalog.js";
import {
  RUNTIME_MODEL_MAX_MODEL_BYTES,
  RUNTIME_MODEL_MAX_MODELS,
  RUNTIME_MODEL_PRICE_ATTESTATION_MAX_AGE_MS,
  projectRuntimeModels,
} from "../dist/runtime-model.js";

function runtimeModel(overrides = {}) {
  return {
    schemaVersion: 1,
    provider: "anthropic",
    model: "claude-haiku-4-5",
    execution: "executable",
    credentialReadiness: "ready",
    modalities: {
      input: ["text", "image"],
      output: ["text"],
    },
    limits: {
      contextTokens: 200_000,
      outputTokens: 64_000,
    },
    ...overrides,
  };
}

test("runtime facts remain authoritative while catalog supplies accounting only", () => {
  const projected = projectRuntimeModels([runtimeModel({
    execution: "unavailable",
    credentialReadiness: "missing",
    modalities: { input: ["audio"], output: null },
    limits: { contextTokens: 123, outputTokens: 7 },
  })]);

  assert.deepEqual(projected, [{
    schemaVersion: 1,
    identity: {
      provider: "anthropic",
      model: "claude-haiku-4-5",
    },
    runtime: {
      execution: "unavailable",
      credentialReadiness: "missing",
      modalities: { input: ["audio"], output: null },
      limits: { contextTokens: 123, outputTokens: 7 },
    },
    usdAccounting: {
      status: "available",
      basis: "public_catalog",
      priceFingerprint: projected[0].usdAccounting.priceFingerprint,
      provenanceSha256: PRICE_PROVENANCE_SHA256,
    },
  }]);
  assert.equal(projected[0].usdAccounting.status, "available");
  assert.equal(projected[0].usdAccounting.priceFingerprint.includes(
    PRICE_PROVENANCE_SHA256,
  ), true);
});

test("catalog cannot create models or make an unknown-price runtime model unavailable", () => {
  assert.deepEqual(projectRuntimeModels([]), []);

  const projected = projectRuntimeModels([runtimeModel({
    provider: "local-runtime",
    model: "private-model",
    modalities: { input: null, output: null },
    limits: { contextTokens: null, outputTokens: null },
  })]);
  assert.equal(projected.length, 1);
  assert.equal(projected[0].runtime.execution, "executable");
  assert.equal(projected[0].runtime.credentialReadiness, "ready");
  assert.deepEqual(projected[0].usdAccounting, { status: "unknown" });
  assert.equal("usd" in projected[0].usdAccounting, false);
});

test("catalog join uses provider and model identity together", () => {
  const [known, wrongProvider, wrongCase] = projectRuntimeModels([
    runtimeModel(),
    runtimeModel({ provider: "other-runtime" }),
    runtimeModel({ provider: "Anthropic" }),
  ]);
  assert.equal(known.usdAccounting.status, "available");
  assert.equal(wrongProvider.usdAccounting.status, "unknown");
  assert.equal(wrongCase.usdAccounting.status, "unknown");
});

test("scheduled catalog prices require an exact owned accounting instant", () => {
  const deepseek = runtimeModel({
    provider: "deepseek",
    model: "deepseek-v4-flash",
  });
  assert.deepEqual(projectRuntimeModels([deepseek])[0].usdAccounting, {
    status: "unknown",
  });
  const priced = projectRuntimeModels([deepseek], {
    accountingAt: "2026-08-17T01:00:00.000Z",
  })[0].usdAccounting;
  assert.equal(priced.status, "available");
  assert.equal(priced.basis, "public_catalog");

  for (const accountingAt of [
    "1900-01-01T00:00:00.000Z",
    "9999-01-01T00:00:00.000Z",
  ]) {
    assert.deepEqual(projectRuntimeModels([deepseek], { accountingAt })[0].usdAccounting, {
      status: "unknown",
    });
  }

  assert.throws(
    () => projectRuntimeModels([deepseek], { accountingAt: "2026-08-17" }),
    /cave_runtime_model_invalid:accounting_at/,
  );
});

test("catalog snapshots only attest a bounded exact accounting interval", () => {
  assert.equal(RUNTIME_MODEL_PRICE_ATTESTATION_MAX_AGE_MS, 30 * 24 * 60 * 60 * 1_000);
  assert.equal(projectRuntimeModels([runtimeModel()], {
    accountingAt: "2026-08-17T00:00:00.000Z",
  })[0].usdAccounting.status, "available");
  for (const accountingAt of [
    "1900-01-01T00:00:00.000Z",
    "9999-01-01T00:00:00.000Z",
  ]) {
    assert.deepEqual(projectRuntimeModels([runtimeModel()], { accountingAt })[0].usdAccounting, {
      status: "unknown",
    });
  }
});

test("projection detaches and deeply freezes caller-owned runtime facts", () => {
  const input = runtimeModel();
  const projected = projectRuntimeModels([input]);
  input.provider = "mutated";
  input.modalities.input[0] = "audio";
  input.limits.contextTokens = 1;

  assert.equal(projected[0].identity.provider, "anthropic");
  assert.deepEqual(projected[0].runtime.modalities.input, ["text", "image"]);
  assert.equal(projected[0].runtime.limits.contextTokens, 200_000);
  assert.equal(Object.isFrozen(projected), true);
  assert.equal(Object.isFrozen(projected[0]), true);
  assert.equal(Object.isFrozen(projected[0].identity), true);
  assert.equal(Object.isFrozen(projected[0].runtime), true);
  assert.equal(Object.isFrozen(projected[0].runtime.modalities), true);
  assert.equal(Object.isFrozen(projected[0].runtime.modalities.input), true);
  assert.equal(Object.isFrozen(projected[0].runtime.limits), true);
  assert.equal(Object.isFrozen(projected[0].usdAccounting), true);
  assert.throws(() => projected[0].runtime.modalities.input.push("audio"), TypeError);
});

test("duplicate and ambiguous identities fail closed", () => {
  assert.throws(
    () => projectRuntimeModels([runtimeModel(), runtimeModel()]),
    /cave_runtime_model_invalid:duplicate:1/,
  );
  assert.throws(
    () => projectRuntimeModels([runtimeModel({ provider: "anthropic/other" })]),
    /cave_runtime_model_invalid:model:0/,
  );
  assert.throws(
    () => projectRuntimeModels([runtimeModel({ model: " claude-haiku-4-5" })]),
    /cave_runtime_model_invalid:model:0/,
  );
  assert.throws(
    () => projectRuntimeModels([runtimeModel({ model: `x${"a".repeat(RUNTIME_MODEL_MAX_MODEL_BYTES)}` })]),
    /cave_runtime_model_invalid:model:0/,
  );
});

test("unknown, empty, and known runtime capability states remain distinct", () => {
  const [unknown, unsupported] = projectRuntimeModels([
    runtimeModel({
      provider: "local-runtime",
      model: "unknown-capabilities",
      execution: "unknown",
      credentialReadiness: "unknown",
      modalities: { input: null, output: null },
      limits: { contextTokens: null, outputTokens: null },
    }),
    runtimeModel({
      provider: "local-runtime",
      model: "unsupported-capabilities",
      execution: "unavailable",
      credentialReadiness: "missing",
      modalities: { input: ["video"], output: [] },
      limits: { contextTokens: null, outputTokens: null },
    }),
  ]);
  assert.equal(unknown.runtime.modalities.input, null);
  assert.deepEqual(unsupported.runtime.modalities.input, ["video"]);
  assert.equal(unknown.runtime.execution, "unknown");
  assert.equal(unsupported.runtime.execution, "unavailable");
});

test("strict bounded data rejects extras, accessors, prototypes, sparse arrays, and invalid limits", () => {
  assert.throws(
    () => projectRuntimeModels([runtimeModel({ displayName: "must not exist" })]),
    /cave_runtime_model_invalid:model:0/,
  );
  assert.throws(
    () => projectRuntimeModels([Object.assign(Object.create({ inherited: true }), runtimeModel())]),
    /cave_runtime_model_invalid:model:0/,
  );

  let reads = 0;
  const accessor = runtimeModel();
  Object.defineProperty(accessor, "provider", {
    enumerable: true,
    get() {
      reads++;
      return "anthropic";
    },
  });
  assert.throws(
    () => projectRuntimeModels([accessor]),
    /cave_runtime_model_invalid:model:0/,
  );
  assert.equal(reads, 0);

  const sparse = new Array(1);
  assert.throws(
    () => projectRuntimeModels(sparse),
    /cave_runtime_model_invalid:models/,
  );
  assert.throws(
    () => projectRuntimeModels(new Array(RUNTIME_MODEL_MAX_MODELS + 1).fill(runtimeModel())),
    /cave_runtime_model_invalid:models/,
  );
  assert.throws(
    () => projectRuntimeModels([runtimeModel({
      modalities: { input: ["text", "text"], output: ["text"] },
    })]),
    /cave_runtime_model_invalid:modalities:0:input/,
  );
  assert.throws(
    () => projectRuntimeModels([runtimeModel({
      limits: { contextTokens: 10, outputTokens: 0 },
    })]),
    /cave_runtime_model_invalid:limits:0:output/,
  );
});
