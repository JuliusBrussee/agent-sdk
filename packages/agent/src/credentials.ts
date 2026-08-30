export type CredentialPurpose = "model" | "embedding" | "gateway";

export interface CredentialRequest {
  readonly provider: string;
  readonly model?: string;
  readonly purpose: CredentialPurpose;
  readonly signal?: AbortSignal;
}

export interface CredentialMetadata {
  readonly provider: string;
  readonly kind: "api_key" | "oauth" | "other" | "unknown";
  readonly billing: "metered" | "subscription" | "unknown";
  readonly expiresAt?: number;
  readonly revision?: string;
}

export interface CredentialMaterial {
  /** Explicitly invoke a configured keyless provider; never consult ambient auth. */
  readonly keyless?: true;
  readonly apiKey?: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Provider-scoped config carried explicitly; never inherited from process.env. */
  readonly env?: Readonly<Record<string, string>>;
  readonly baseURL?: string;
}

export interface ResolvedCredential {
  readonly metadata: CredentialMetadata;
  readonly material: CredentialMaterial;
}

export interface CredentialResolver {
  inspect?(
    request: Readonly<CredentialRequest>,
  ): CredentialMetadata | undefined | PromiseLike<CredentialMetadata | undefined>;
  resolve(
    request: Readonly<CredentialRequest>,
  ): ResolvedCredential | undefined | PromiseLike<ResolvedCredential | undefined>;
}

const REQUEST_KEYS = Object.freeze(["provider", "model", "purpose", "signal"]);
const METADATA_KEYS = Object.freeze([
  "provider",
  "kind",
  "billing",
  "expiresAt",
  "revision",
]);
const MATERIAL_KEYS = Object.freeze(["keyless", "apiKey", "headers", "env", "baseURL"]);
const RESOLVED_KEYS = Object.freeze(["metadata", "material"]);
const PROVIDER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const KINDS = Object.freeze(["api_key", "oauth", "other", "unknown"]);
const BILLING = Object.freeze(["metered", "subscription", "unknown"]);
const PURPOSES = Object.freeze(["model", "embedding", "gateway"]);
const MAX_SECRET_LENGTH = 64 * 1024;
const MAX_HEADERS = 32;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_ENV = 64;
const MAX_ENV_BYTES = 64 * 1024;

/** Metadata-only lookup. Resolver failures never expose thrown secret text. */
export async function inspectCredential(
  resolver: CredentialResolver,
  request: CredentialRequest,
): Promise<CredentialMetadata | undefined> {
  const inspect = requireResolver(resolver).inspect;
  const normalizedRequest = normalizeCredentialRequest(request);
  throwIfAborted(normalizedRequest.signal);
  if (inspect === undefined) return undefined;
  let value: CredentialMetadata | undefined;
  try {
    value = await abortable(
      inspect(normalizedRequest),
      normalizedRequest.signal,
      () => new Error("cave_credential_aborted"),
    );
  } catch {
    throwIfAborted(normalizedRequest.signal);
    throw new Error("cave_credential_inspect_failed");
  }
  throwIfAborted(normalizedRequest.signal);
  return value === undefined
    ? undefined
    : normalizeCredentialMetadata(value, normalizedRequest.provider);
}

/** Just-in-time secret resolution. Returned material is detached and never cached. */
export async function resolveCredential(
  resolver: CredentialResolver,
  request: CredentialRequest,
): Promise<ResolvedCredential> {
  const resolve = requireResolver(resolver).resolve;
  const normalizedRequest = normalizeCredentialRequest(request);
  throwIfAborted(normalizedRequest.signal);
  let value: ResolvedCredential | undefined;
  try {
    value = await abortable(
      resolve(normalizedRequest),
      normalizedRequest.signal,
      () => new Error("cave_credential_aborted"),
    );
  } catch {
    throwIfAborted(normalizedRequest.signal);
    throw new Error("cave_credential_resolve_failed");
  }
  throwIfAborted(normalizedRequest.signal);
  if (value === undefined) throw new Error("cave_credential_unavailable");
  const normalized = normalizeResolvedCredential(value, normalizedRequest.provider);
  if (normalized.metadata.expiresAt !== undefined &&
      normalized.metadata.expiresAt <= Date.now()) {
    throw new Error("cave_credential_expired");
  }
  return normalized;
}

/** Billing fact only. USD claims separately require complete usage and price evidence. */
export function credentialIsMetered(value: CredentialMetadata): boolean {
  return normalizeCredentialMetadata(value).billing === "metered";
}

export function normalizeCredentialRequest(value: unknown): Readonly<CredentialRequest> {
  const request = snapshotRecord(value, REQUEST_KEYS, ["provider", "purpose"], "request");
  requireText(request.provider, PROVIDER, "provider");
  requireOneOf(request.purpose, PURPOSES, "purpose");
  if (request.model !== undefined) requireBoundedString(request.model, 512, "model");
  if (request.signal !== undefined && !(request.signal instanceof AbortSignal)) fail("signal");
  return Object.freeze({
    provider: request.provider as string,
    ...(request.model === undefined ? {} : { model: request.model as string }),
    purpose: request.purpose as CredentialPurpose,
    ...(request.signal === undefined ? {} : { signal: request.signal as AbortSignal }),
  });
}

export function normalizeCredentialMetadata(
  value: unknown,
  expectedProvider?: string,
): CredentialMetadata {
  const metadata = snapshotRecord(
    value,
    METADATA_KEYS,
    ["provider", "kind", "billing"],
    "metadata",
  );
  requireText(metadata.provider, PROVIDER, "metadata_provider");
  if (expectedProvider !== undefined && metadata.provider !== expectedProvider) {
    fail("metadata_provider_mismatch");
  }
  requireOneOf(metadata.kind, KINDS, "metadata_kind");
  requireOneOf(metadata.billing, BILLING, "metadata_billing");
  if (metadata.expiresAt !== undefined &&
      (!Number.isSafeInteger(metadata.expiresAt) || (metadata.expiresAt as number) < 0)) {
    fail("metadata_expires_at");
  }
  if (metadata.revision !== undefined) {
    requireBoundedString(metadata.revision, 256, "metadata_revision");
  }
  return Object.freeze({
    provider: metadata.provider as string,
    kind: metadata.kind as CredentialMetadata["kind"],
    billing: metadata.billing as CredentialMetadata["billing"],
    ...(metadata.expiresAt === undefined ? {} : { expiresAt: metadata.expiresAt as number }),
    ...(metadata.revision === undefined ? {} : { revision: metadata.revision as string }),
  });
}

export function normalizeResolvedCredential(
  value: unknown,
  expectedProvider?: string,
): ResolvedCredential {
  const resolved = snapshotRecord(value, RESOLVED_KEYS, RESOLVED_KEYS, "resolved");
  const metadata = normalizeCredentialMetadata(resolved.metadata, expectedProvider);
  const materialValue = snapshotRecord(resolved.material, MATERIAL_KEYS, [], "material");

  const material: {
    keyless?: true;
    apiKey?: string;
    headers?: Readonly<Record<string, string>>;
    env?: Readonly<Record<string, string>>;
    baseURL?: string;
  } = {};
  if (materialValue.keyless !== undefined) {
    if (materialValue.keyless !== true) fail("keyless");
    material.keyless = true;
  }
  if (materialValue.apiKey !== undefined) {
    requireSecret(materialValue.apiKey, "api_key");
    material.apiKey = materialValue.apiKey;
  }
  if (materialValue.headers !== undefined) {
    material.headers = normalizeHeaders(materialValue.headers);
  }
  if (materialValue.env !== undefined) {
    material.env = normalizeEnvironment(materialValue.env);
  }
  if (materialValue.baseURL !== undefined) {
    material.baseURL = normalizeBaseURL(materialValue.baseURL);
  }
  if (material.keyless === true && material.apiKey !== undefined) fail("keyless");
  if (material.keyless !== true && material.apiKey === undefined &&
      material.headers === undefined && material.env === undefined) {
    fail("material_missing");
  }
  return Object.freeze({ metadata, material: Object.freeze(material) });
}

function normalizeEnvironment(value: unknown): Readonly<Record<string, string>> {
  const environment = snapshotDataDictionary(value, MAX_ENV, () => fail("env"));
  const keys = Object.keys(environment);
  if (keys.length === 0 || keys.some((key) => !ENV_NAME.test(key))) fail("env");
  let bytes = 0;
  const normalized: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const key of keys) {
    const item = environment[key];
    requireSecret(item, "env_value");
    bytes += Buffer.byteLength(key) + Buffer.byteLength(item);
    if (bytes > MAX_ENV_BYTES) fail("env");
    normalized[key] = item;
  }
  return Object.freeze(normalized);
}

function requireResolver(value: unknown): CredentialResolver {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    fail("resolver");
  }
  let resolve: unknown;
  let inspect: unknown;
  try {
    resolve = Reflect.get(value, "resolve");
    inspect = Reflect.get(value, "inspect");
  } catch {
    fail("resolver");
  }
  if (typeof resolve !== "function" ||
      (inspect !== undefined && typeof inspect !== "function")) {
    fail("resolver");
  }
  return {
    resolve(request) {
      return Reflect.apply(resolve, value, [request]);
    },
    ...(inspect === undefined ? {} : {
      inspect(request: Readonly<CredentialRequest>) {
        return Reflect.apply(inspect, value, [request]);
      },
    }),
  };
}

function normalizeHeaders(value: unknown): Readonly<Record<string, string>> {
  const headers = snapshotDataDictionary(value, MAX_HEADERS, () => fail("headers"));
  const keys = Object.keys(headers);
  if (keys.length === 0 || keys.some((key) => !HEADER_NAME.test(key))) {
    fail("headers");
  }
  let bytes = 0;
  const normalized: Record<string, string> = Object.create(null) as Record<string, string>;
  const seen = new Set<string>();
  for (const rawKey of keys) {
    const key = rawKey.toLowerCase();
    if (seen.has(key) || key === "host" || key === "content-length") fail("headers");
    const headerValue = headers[rawKey];
    requireSecret(headerValue, "header_value");
    bytes += Buffer.byteLength(rawKey) + Buffer.byteLength(headerValue);
    if (bytes > MAX_HEADER_BYTES) fail("headers");
    seen.add(key);
    normalized[rawKey] = headerValue;
  }
  return Object.freeze(normalized);
}

function normalizeBaseURL(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) {
    fail("base_url");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    fail("base_url");
  }
  if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.username !== "" || parsed.password !== "" || parsed.hash !== "") {
    fail("base_url");
  }
  // The same material carries apiKey/headers/env secrets to this base URL.
  // Cleartext is only acceptable when it cannot leave the machine.
  if (parsed.protocol === "http:" &&
      !["localhost", "127.0.0.1", "[::1]", "::1"].includes(parsed.hostname)) {
    fail("base_url");
  }
  return parsed.toString();
}

function requireSecret(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_SECRET_LENGTH ||
      /[\0\r\n]/u.test(value)) {
    fail(field);
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new Error("cave_credential_aborted");
}

function snapshotRecord(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
  field: string,
): Readonly<Record<string, unknown>> {
  return snapshotDataRecord(value, allowed, required, () => fail(field));
}

function requireText(value: unknown, pattern: RegExp, field: string): asserts value is string {
  if (typeof value !== "string" || !pattern.test(value)) fail(field);
}

function requireBoundedString(value: unknown, maximum: number, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum ||
      /[\0\r\n]/u.test(value)) {
    fail(field);
  }
}

function requireOneOf(value: unknown, values: readonly string[], field: string): void {
  if (typeof value !== "string" || !values.includes(value)) fail(field);
}

function fail(field: string): never {
  throw new Error(`cave_credential_invalid:${field}`);
}
import { abortable } from "./async-boundary.js";
import { snapshotDataDictionary, snapshotDataRecord } from "./strict-data.js";
