import {
  PRICE_PROVENANCE_SHA256,
  catalogPriceFingerprint,
  catalogPriceVerifiedAt,
} from "./catalog.js";
import { snapshotDataRecord, snapshotDenseArray } from "./strict-data.js";

export const RUNTIME_MODEL_MAX_MODELS = 8_192;
export const RUNTIME_MODEL_MAX_MODALITIES = 8;
export const RUNTIME_MODEL_MAX_PROVIDER_LENGTH = 128;
export const RUNTIME_MODEL_MAX_MODEL_BYTES = 1_024;
export const RUNTIME_MODEL_MAX_MODALITY_LENGTH = 64;
/** Maximum interval one reviewed catalog price can attest for exact accounting. */
export const RUNTIME_MODEL_PRICE_ATTESTATION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

export type RuntimeModelExecution = "executable" | "unavailable" | "unknown";
export type RuntimeModelCredentialReadiness = "ready" | "missing" | "unknown";
export type RuntimeModelModality = string;

/**
 * Facts supplied by one runtime/provider registry. Price, display, tier, and
 * default-model metadata deliberately do not belong here.
 */
export interface RuntimeModelFacts {
  readonly schemaVersion: 1;
  readonly provider: string;
  readonly model: string;
  readonly execution: RuntimeModelExecution;
  readonly credentialReadiness: RuntimeModelCredentialReadiness;
  readonly modalities: {
    /** `null` means the runtime cannot attest supported input modalities. */
    readonly input: readonly RuntimeModelModality[] | null;
    /** `null` means the runtime cannot attest supported output modalities. */
    readonly output: readonly RuntimeModelModality[] | null;
  };
  readonly limits: {
    /** `null` is unknown, never unlimited. */
    readonly contextTokens: number | null;
    /** `null` is unknown, never unlimited. */
    readonly outputTokens: number | null;
  };
}

export type RuntimeModelUSDAccounting =
  | Readonly<{
    status: "available";
    basis: "public_catalog";
    priceFingerprint: string;
    provenanceSha256: string;
  }>
  | Readonly<{ status: "unknown" }>;

/**
 * Projection of runtime-owned execution facts plus catalog-owned accounting
 * identity. Catalog data can annotate a runtime row, never create or modify it.
 */
export interface ProjectedRuntimeModel {
  readonly schemaVersion: 1;
  readonly identity: {
    readonly provider: string;
    readonly model: string;
  };
  readonly runtime: {
    readonly execution: RuntimeModelExecution;
    readonly credentialReadiness: RuntimeModelCredentialReadiness;
    readonly modalities: {
      readonly input: readonly RuntimeModelModality[] | null;
      readonly output: readonly RuntimeModelModality[] | null;
    };
    readonly limits: {
      readonly contextTokens: number | null;
      readonly outputTokens: number | null;
    };
  };
  readonly usdAccounting: RuntimeModelUSDAccounting;
}

export interface RuntimeModelProjectionOptions {
  /** Exact owned accounting instant. Must fall inside catalog attestation interval. */
  readonly accountingAt?: string;
}

const MODEL_KEYS = Object.freeze([
  "schemaVersion",
  "provider",
  "model",
  "execution",
  "credentialReadiness",
  "modalities",
  "limits",
]);
const MODALITIES_KEYS = Object.freeze(["input", "output"]);
const LIMITS_KEYS = Object.freeze(["contextTokens", "outputTokens"]);
const OPTIONS_KEYS = Object.freeze(["accountingAt"]);
const PROVIDER = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,127})$/;
const MODALITY = /^[a-z](?:[a-z0-9._-]{0,63})$/;
const SHA256 = /^[0-9a-f]{64}$/;
const EXECUTION_STATES = Object.freeze(["executable", "unavailable", "unknown"] as const);
const CREDENTIAL_STATES = Object.freeze(["ready", "missing", "unknown"] as const);

/** Validate, detach, freeze, and account runtime model facts without I/O. */
export function projectRuntimeModels(
  models: readonly RuntimeModelFacts[],
  options: RuntimeModelProjectionOptions = {},
): readonly ProjectedRuntimeModel[] {
  const rows = snapshotDenseArray(
    models,
    RUNTIME_MODEL_MAX_MODELS,
    () => fail("models"),
  );
  const normalizedOptions = snapshotDataRecord(
    options,
    OPTIONS_KEYS,
    [],
    () => fail("options"),
  );
  const accountingAt = normalizeAccountingAt(normalizedOptions["accountingAt"]);
  const seen = new Set<string>();
  const projected: ProjectedRuntimeModel[] = [];

  for (let index = 0; index < rows.length; index++) {
    const runtime = normalizeRuntimeModel(rows[index], index);
    const key = `${runtime.provider}\0${runtime.model}`;
    if (seen.has(key)) fail(`duplicate:${index}`);
    seen.add(key);

    const priceFingerprint = catalogPriceFingerprint(
      runtime.provider,
      runtime.model,
      accountingAt,
    );
    const priceVerifiedAt = catalogPriceVerifiedAt(
      runtime.provider,
      runtime.model,
    );
    projected.push(Object.freeze({
      schemaVersion: 1,
      identity: Object.freeze({
        provider: runtime.provider,
        model: runtime.model,
      }),
      runtime: Object.freeze({
        execution: runtime.execution,
        credentialReadiness: runtime.credentialReadiness,
        modalities: runtime.modalities,
        limits: runtime.limits,
      }),
      usdAccounting: accountingProjection(priceFingerprint, priceVerifiedAt, accountingAt),
    }));
  }

  return Object.freeze(projected);
}

function normalizeRuntimeModel(value: unknown, index: number): RuntimeModelFacts {
  const model = snapshotDataRecord(
    value,
    MODEL_KEYS,
    MODEL_KEYS,
    () => fail(`model:${index}`),
  );
  const provider = model["provider"];
  const modelID = model["model"];
  const execution = model["execution"];
  const credentialReadiness = model["credentialReadiness"];
  if (model["schemaVersion"] !== 1 ||
      typeof provider !== "string" || provider.length > RUNTIME_MODEL_MAX_PROVIDER_LENGTH ||
      !PROVIDER.test(provider) ||
      !isModelID(modelID) ||
      !isOneOf(execution, EXECUTION_STATES) ||
      !isOneOf(credentialReadiness, CREDENTIAL_STATES)) {
    fail(`model:${index}`);
  }

  const modalities = snapshotDataRecord(
    model["modalities"],
    MODALITIES_KEYS,
    MODALITIES_KEYS,
    () => fail(`modalities:${index}`),
  );
  const input = normalizeModalities(modalities["input"], index, "input");
  const output = normalizeModalities(modalities["output"], index, "output");
  const limits = snapshotDataRecord(
    model["limits"],
    LIMITS_KEYS,
    LIMITS_KEYS,
    () => fail(`limits:${index}`),
  );
  const contextTokens = normalizeLimit(limits["contextTokens"], index, "context");
  const outputTokens = normalizeLimit(limits["outputTokens"], index, "output");

  return Object.freeze({
    schemaVersion: 1,
    provider,
    model: modelID,
    execution,
    credentialReadiness,
    modalities: Object.freeze({ input, output }),
    limits: Object.freeze({ contextTokens, outputTokens }),
  });
}

function normalizeModalities(
  value: unknown,
  index: number,
  direction: "input" | "output",
): readonly RuntimeModelModality[] | null {
  if (value === null) return null;
  const items = snapshotDenseArray(
    value,
    RUNTIME_MODEL_MAX_MODALITIES,
    () => fail(`modalities:${index}:${direction}`),
  );
  const seen = new Set<string>();
  const normalized: RuntimeModelModality[] = [];
  for (const item of items) {
    if (typeof item !== "string" || item.length > RUNTIME_MODEL_MAX_MODALITY_LENGTH ||
        !MODALITY.test(item)) {
      fail(`modalities:${index}:${direction}`);
    }
    if (seen.has(item)) fail(`modalities:${index}:${direction}`);
    seen.add(item);
    normalized.push(item);
  }
  return Object.freeze(normalized);
}

function normalizeLimit(
  value: unknown,
  index: number,
  name: "context" | "output",
): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    fail(`limits:${index}:${name}`);
  }
  return value as number;
}

function normalizeAccountingAt(value: unknown): Date | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 40) fail("accounting_at");
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    fail("accounting_at");
  }
  return parsed;
}

function accountingProjection(
  priceFingerprint: string | undefined,
  priceVerifiedAt: string | undefined,
  accountingAt: Date | undefined,
): RuntimeModelUSDAccounting {
  // Explicit accounting instants need a bounded source-review attestation.
  // This blocks both historical backdating and indefinite future projection.
  if (priceFingerprint === undefined ||
      (accountingAt !== undefined && !priceAttestsInstant(priceVerifiedAt, accountingAt))) {
    return Object.freeze({ status: "unknown" });
  }
  if (Buffer.byteLength(priceFingerprint, "utf8") > 4_096 ||
      !SHA256.test(PRICE_PROVENANCE_SHA256)) {
    fail("catalog_accounting");
  }
  return Object.freeze({
    status: "available",
    basis: "public_catalog",
    priceFingerprint,
    provenanceSha256: PRICE_PROVENANCE_SHA256,
  });
}

function priceAttestsInstant(verifiedAt: string | undefined, accountingAt: Date): boolean {
  if (verifiedAt === undefined) return false;
  const verifiedTime = Date.parse(verifiedAt);
  if (!Number.isFinite(verifiedTime)) return false;
  const accountingTime = accountingAt.getTime();
  return accountingTime >= verifiedTime &&
    accountingTime - verifiedTime <= RUNTIME_MODEL_PRICE_ATTESTATION_MAX_AGE_MS;
}

function isModelID(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.trim() === value &&
    Buffer.byteLength(value, "utf8") <= RUNTIME_MODEL_MAX_MODEL_BYTES &&
    !/[\0-\x1f\x7f]/u.test(value);
}

function isOneOf<T extends string>(value: unknown, choices: readonly T[]): value is T {
  return typeof value === "string" && choices.includes(value as T);
}

function fail(field: string): never {
  throw new Error(`cave_runtime_model_invalid:${field}`);
}
