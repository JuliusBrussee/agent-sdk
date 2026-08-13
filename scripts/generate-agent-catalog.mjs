#!/usr/bin/env node
// Generates packages/agent/src/catalog.ts from typed JSON artifact compiled from
// this repository's pinned provider-catalog source of truth.
//
// The generated module carries a truthful CATALOG_SHA256 (the sha256 of the
// catalog bytes it was generated from). packages/agent/tests/catalog.drift.runtime.mjs
// recomputes both the digest and the rendered module, so an edited catalog fails
// the suite until this script is re-run.
//
// Usage:
//   node scripts/generate-agent-catalog.mjs            # write packages/agent/src/catalog.ts
//   node scripts/generate-agent-catalog.mjs --out FILE # write elsewhere
//   node scripts/generate-agent-catalog.mjs --check    # exit 1 if the file is stale
//
// No YAML parser lives here. Go catalog validation + typed export compile one
// canonical JSON artifact first; this renderer consumes only that artifact.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_PUBLIC_ROOT = resolve(REPO_ROOT, "public");
const AGENT_ROOT = existsSync(resolve(SOURCE_PUBLIC_ROOT, "agent/package.json"))
  ? resolve(SOURCE_PUBLIC_ROOT, "agent")
  : resolve(REPO_ROOT, "packages/agent");
const catalogCandidates = [
  resolve(SOURCE_PUBLIC_ROOT, "shared/provider-catalog/catalog/current.yaml"),
  resolve(REPO_ROOT, "shared/provider-catalog/catalog/current.yaml"),
  resolve(REPO_ROOT, "packages/shared/provider-catalog/catalog/current.yaml"),
];
export const CATALOG_PATH = catalogCandidates.find((candidate) => existsSync(candidate)) ?? catalogCandidates[0];
export const OUTPUT_PATH = resolve(AGENT_ROOT, "src/catalog.ts");
const artifactCandidates = [
  resolve(SOURCE_PUBLIC_ROOT, "shared/provider-catalog/generated/catalog.json"),
  resolve(REPO_ROOT, "shared/provider-catalog/generated/catalog.json"),
  resolve(REPO_ROOT, "packages/shared/provider-catalog/generated/catalog.json"),
];
export const ARTIFACT_PATH = artifactCandidates.find((candidate) => existsSync(candidate)) ?? artifactCandidates[0];

const CATALOG_LABEL = "packages/shared/provider-catalog/catalog/current.yaml";
const GENERATOR_LABEL = "scripts/generate-agent-catalog.mjs";

// Catalog's own region-agnostic marker. catalog/catalog.go uses same
// rule: only a `global` row answers a generic, region-free price lookup, because
// borrowing a regional row would fabricate spend.
const REGION_AGNOSTIC = "global";
const REQUIRED_CURRENCY = "USD";
const PRICEABLE_LIFECYCLES = new Set(["reviewed", "routable"]);
const LIFECYCLES = new Set(["discovered", "reviewed", "routable", "retired"]);
const CACHE_MODES = new Set(["explicit", "implicit", "affinity", "automatic"]);

/** Selects the runtime-eligible, region-agnostic, USD rows the agent can use. */
export function selectRows(rows, label = CATALOG_LABEL) {
  const selected = [];
  const models = [];
  const skippedByKey = new Map();
  const seenPrices = new Set();
  const seenModels = new Set();
  const record = (key) => {
    let entry = skippedByKey.get(key);
    if (entry === undefined) {
      entry = { regions: [], reasons: [] };
      skippedByKey.set(key, entry);
    }
    return entry;
  };
  const skipRegional = (key, region) => {
    const entry = record(key);
    if (!entry.regions.includes(region)) entry.regions.push(region);
  };
  const skip = (key, reason) => {
    const entry = record(key);
    if (!entry.reasons.includes(reason)) entry.reasons.push(reason);
  };
  for (const row of rows) {
    for (const field of ["provider", "model", "region", "currency"]) {
      if (typeof row[field] !== "string" || row[field] === "") {
        throw new Error(`${label}: row is missing a string "${field}"`);
      }
    }
    const key = `${row.provider}/${row.model}`;
    const lifecycle = row.lifecycle?.status;
    if (!LIFECYCLES.has(lifecycle)) {
      throw new Error(`${label}: ${key} has invalid lifecycle ${String(lifecycle)}`);
    }
    if (row.region === REGION_AGNOSTIC && row.currency === REQUIRED_CURRENCY) {
      if (seenModels.has(key)) throw new Error(`${label}: duplicate region-agnostic model ${key}`);
      seenModels.add(key);
      models.push({
        key,
        model: {
          lifecycle,
          messagesAPI: supportState(row.capabilities?.messages_api, `${key}.messages_api`, label),
          adaptiveThinking: supportState(row.capabilities?.adaptive_thinking, `${key}.adaptive_thinking`, label),
          manualThinking: supportState(row.capabilities?.manual_thinking, `${key}.manual_thinking`, label),
        },
      });
    }
    if (!PRICEABLE_LIFECYCLES.has(lifecycle)) {
      skip(key, `lifecycle ${lifecycle} is not priceable`);
      continue;
    }
    if (row.region !== REGION_AGNOSTIC) {
      skipRegional(key, row.region);
      continue;
    }
    if (row.currency !== REQUIRED_CURRENCY) {
      skip(key, `priced in ${row.currency}, not ${REQUIRED_CURRENCY}`);
      continue;
    }
    if (row.pricing === null || typeof row.pricing !== "object" || Array.isArray(row.pricing)) {
      throw new Error(`${label}: ${key} has no pricing block`);
    }
    const input = rate(row.pricing.input_per_million, `${key}.input_per_million`, label);
    const output = rate(row.pricing.output_per_million, `${key}.output_per_million`, label);
    if (input === null || output === null) {
      skip(key, "no list price for input or output tokens");
      continue;
    }
    if (seenPrices.has(key)) throw new Error(`${label}: duplicate region-agnostic row ${key}`);
    seenPrices.add(key);
    selected.push({
      key,
      price: {
        inputPerMillion: input,
        outputPerMillion: output,
        cacheMode: cacheMode(row.cache_profile, key, label),
        cacheReadPerMillion: rate(row.pricing.cache_read_input_per_million, `${key}.cache_read_input_per_million`, label),
        cacheWritePerMillion: rate(row.pricing.cache_write_input_per_million, `${key}.cache_write_input_per_million`, label),
        reasoningPerMillion: rate(row.pricing.reasoning_output_per_million, `${key}.reasoning_output_per_million`, label),
      },
    });
  }
  selected.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  models.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  const skipped = [...skippedByKey.entries()]
    .map(([key, entry]) => {
      const reasons = [...entry.reasons].sort();
      if (entry.regions.length > 0) {
        reasons.unshift(`priced per region only (${[...entry.regions].sort().join(", ")})`);
      }
      return { key, reason: reasons.join("; ") };
    })
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  return { selected, models, skipped };
}

function supportState(value, field, label) {
  if (value === "supported" || value === "unsupported" || value === "unknown") return value;
  throw new Error(`${label}: ${field} must be supported, unsupported, or unknown`);
}

function cacheMode(profile, key, label) {
  const state = profile?.state;
  if (state === "unknown" || state === "unsupported") return state;
  if (state === "supported" && CACHE_MODES.has(profile.mode)) return profile.mode;
  throw new Error(`${label}: ${key}.cache_profile has invalid state or mode`);
}

function rate(value, field, label) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label}: ${field} must be a finite non-negative number`);
  }
  return value;
}

function number(value) {
  const text = String(value);
  if (!/^(0|[1-9][0-9]*)(\.[0-9]+)?(e[+-]?[0-9]+)?$/.test(text)) {
    throw new Error(`cannot render ${text} as a stable numeric literal`);
  }
  return text;
}

function nullableNumber(value) {
  return value === null ? "null" : number(value);
}

/** Renders the full packages/agent/src/catalog.ts module text. */
export function renderCatalogModule(catalogBytes, artifact, label = CATALOG_LABEL) {
  const digest = createHash("sha256").update(catalogBytes).digest("hex");
  if (artifact?.schema_version !== "provider-catalog.generated.v1" ||
      !Array.isArray(artifact.entries) || artifact.entries.length === 0 ||
      !/^[0-9a-f]{64}$/.test(artifact.catalog_semantic_sha256 ?? "") ||
      !/^[0-9a-f]{64}$/.test(artifact.price_provenance_sha256 ?? "") ||
      artifact.source_sha256 !== digest) {
    throw new Error(`${label}: generated provider artifact is missing, malformed, or stale`);
  }
  const { selected, models: selectedModels, skipped } = selectRows(artifact.entries, label);
  if (selected.length === 0) throw new Error(`${label}: no priced region-agnostic rows found`);
  const entries = selected.map(({ key, price }) => [
    `  ${JSON.stringify(key)}: Object.freeze({`,
    `    inputPerMillion: ${number(price.inputPerMillion)},`,
    `    outputPerMillion: ${number(price.outputPerMillion)},`,
    `    cacheMode: ${JSON.stringify(price.cacheMode)},`,
    `    cacheReadPerMillion: ${nullableNumber(price.cacheReadPerMillion)},`,
    `    cacheWritePerMillion: ${nullableNumber(price.cacheWritePerMillion)},`,
    `    reasoningPerMillion: ${nullableNumber(price.reasoningPerMillion)},`,
    `  }),`,
  ].join("\n")).join("\n");
  const models = selectedModels.map(({ key, model }) => [
    `  ${JSON.stringify(key)}: Object.freeze({`,
    `    lifecycle: ${JSON.stringify(model.lifecycle)},`,
    `    messagesAPI: ${JSON.stringify(model.messagesAPI)},`,
    `    adaptiveThinking: ${JSON.stringify(model.adaptiveThinking)},`,
    `    manualThinking: ${JSON.stringify(model.manualThinking)},`,
    `  }),`,
  ].join("\n")).join("\n");
  const skippedLines = skipped.length === 0
    ? "// Every catalog row is represented above.\n"
    : [
      "// Rows deliberately absent above. A regional rate is not a region-free",
      "// rate, so these are omitted rather than borrowed; a run on one of these",
      "// models prices as unpriced (honest zero) instead of plausibly wrong.",
      ...skipped.map(({ key, reason }) => `//   ${key} — ${reason}`),
      "",
    ].join("\n");

  return `// GENERATED by ${GENERATOR_LABEL} — do not edit.
// Source: ${CATALOG_LABEL}, the repo's single pricing source of truth.
// CATALOG_SHA256 is the sha256 of those exact catalog bytes; the drift test in
// tests/catalog.drift.runtime.mjs fails until the generator is re-run.
//
// Included: every reviewed or routable USD row the catalog prices
// region-agnostically (region: ${REGION_AGNOSTIC}). Field mapping, catalog key
// -> TypeScript field:
//   input_per_million             -> inputPerMillion
//   output_per_million            -> outputPerMillion
//   cache_read_input_per_million  -> cacheReadPerMillion
//   cache_write_input_per_million -> cacheWritePerMillion
//   reasoning_output_per_million  -> reasoningPerMillion
// Optional null rates remain unknown. Costing and reservation fail closed when
// a corresponding observed or potentially used token class is nonzero; an
// explicit numeric 0 remains a reviewed free rate.
// Not modeled: 1h cache-write rates, batch discounts, cache storage, and
// long-context multipliers. These numbers are standard-tier public list-price
// subtotals, never an invoice.
export const CATALOG_SHA256 = "${digest}";
export const CATALOG_SEMANTIC_SHA256 = "${artifact.catalog_semantic_sha256}";
export const PRICE_PROVENANCE_SHA256 = "${artifact.price_provenance_sha256}";

export interface CatalogPrice {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheMode: "unknown" | "unsupported" | "explicit" | "implicit" | "affinity" | "automatic";
  cacheReadPerMillion: number | null;
  cacheWritePerMillion: number | null;
  reasoningPerMillion: number | null;
}

export type CatalogSupportState = "unknown" | "unsupported" | "supported";

export interface CatalogModelFacts {
  lifecycle: "discovered" | "reviewed" | "routable" | "retired";
  messagesAPI: CatalogSupportState;
  adaptiveThinking: CatalogSupportState;
  manualThinking: CatalogSupportState;
}

export interface CatalogUsage {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}

const PRICES: Readonly<Record<string, CatalogPrice>> = Object.freeze({
${entries}
});

const MODELS: Readonly<Record<string, CatalogModelFacts>> = Object.freeze({
${models}
});

${skippedLines}
function catalogProvider(provider: string): string {
  // Runtime provider IDs come from Pi; catalog IDs name billing surfaces.
  if (provider === "google") return "gemini";
  if (provider === "google-vertex") return "vertex";
  return provider;
}

export function catalogRuntimeModel(
  provider: string,
  model: string,
): CatalogModelFacts | undefined {
  const facts = catalogModelFacts(provider, model);
  return catalogModelRuntimeEligible(facts) ? facts : undefined;
}

export function catalogModelFacts(
  provider: string,
  model: string,
): CatalogModelFacts | undefined {
  return MODELS[\`\${catalogProvider(provider)}/\${model}\`];
}

export function catalogModelRuntimeEligible(
  facts: CatalogModelFacts | undefined,
): facts is CatalogModelFacts {
  return facts !== undefined &&
    (facts.lifecycle === "reviewed" || facts.lifecycle === "routable") &&
    facts.messagesAPI === "supported";
}

export function catalogSearchCeiling(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number | undefined {
  const slash = model.indexOf("/");
  const normalized = slash < 0
    ? model
    : \`\${catalogProvider(model.slice(0, slash))}/\${model.slice(slash + 1)}\`;
  const price = PRICES[normalized];
  if (!price || !Number.isSafeInteger(inputTokens) || inputTokens < 0 ||
      !Number.isSafeInteger(outputTokens) || outputTokens < 0) {
    return undefined;
  }
  const cacheReadPossible = price.cacheMode !== "unsupported";
  const separatelyBilledCacheWritePossible =
    price.cacheMode === "unknown" || price.cacheMode === "explicit";
  if (inputTokens > 0) {
    if (cacheReadPossible && price.cacheReadPerMillion === null) return undefined;
    if (separatelyBilledCacheWritePossible && price.cacheWritePerMillion === null) return undefined;
  }
  if (outputTokens > 0 && price.reasoningPerMillion === null) return undefined;
  const inputRates = [price.inputPerMillion];
  if (inputTokens > 0 && cacheReadPossible) inputRates.push(price.cacheReadPerMillion!);
  if (inputTokens > 0 && separatelyBilledCacheWritePossible) {
    inputRates.push(price.cacheWritePerMillion!);
  }
  const worstInputRate = Math.max(...inputRates);
  const worstOutputRate = outputTokens === 0
    ? price.outputPerMillion
    : Math.max(price.outputPerMillion, price.reasoningPerMillion!);
  const usd = (inputTokens * worstInputRate + outputTokens * worstOutputRate) / 1_000_000;
  return Math.ceil(usd * 1e10) / 1e10;
}

export function catalogCostForPrice(
  price: CatalogPrice | undefined,
  usage: CatalogUsage,
): { priced: boolean; usd: number } {
  if (!price) return { priced: false, usd: 0 };
  if ((usage.cacheReadTokens > 0 && price.cacheReadPerMillion === null) ||
      (usage.cacheWriteTokens > 0 && price.cacheWritePerMillion === null) ||
      (usage.reasoningTokens > 0 && price.reasoningPerMillion === null)) {
    return { priced: false, usd: 0 };
  }
  // Pi normalizes input as uncached input. cacheRead/cacheWrite are disjoint
  // classes, while reasoning remains a subset of output.
  const billableInput = usage.inputTokens;
  const visibleOutput = usage.outputTokens - usage.reasoningTokens;
  if (
    billableInput < 0 ||
    visibleOutput < 0 ||
    Object.values(usage).some((value) => typeof value === "number" && (!Number.isSafeInteger(value) || value < 0))
  ) {
    return { priced: false, usd: 0 };
  }
  const usd = (
    billableInput * price.inputPerMillion +
    usage.cacheReadTokens * (price.cacheReadPerMillion ?? 0) +
    usage.cacheWriteTokens * (price.cacheWritePerMillion ?? 0) +
    visibleOutput * price.outputPerMillion +
    usage.reasoningTokens * (price.reasoningPerMillion ?? 0)
  ) / 1_000_000;
  return { priced: true, usd: Math.round((usd + Number.EPSILON) * 1e10) / 1e10 };
}

export function catalogCost(usage: CatalogUsage): { priced: boolean; usd: number } {
  const provider = catalogProvider(usage.provider);
  return catalogCostForPrice(PRICES[\`\${provider}/\${usage.model}\`], usage);
}
`;
}

export function generate() {
  const artifact = JSON.parse(readFileSync(ARTIFACT_PATH, "utf8"));
  return renderCatalogModule(readFileSync(CATALOG_PATH), artifact);
}

function main(argv) {
  const check = argv.includes("--check");
  const outIndex = argv.indexOf("--out");
  const outPath = outIndex === -1 ? OUTPUT_PATH : resolve(process.cwd(), argv[outIndex + 1] ?? "");
  if (outIndex !== -1 && argv[outIndex + 1] === undefined) {
    process.stderr.write("--out requires a path\n");
    return 2;
  }
  const rendered = generate();
  if (check) {
    const current = readFileSync(outPath, "utf8");
    if (current === rendered) {
      process.stdout.write(`${GENERATOR_LABEL}: catalog.ts is current\n`);
      return 0;
    }
    process.stderr.write(`${GENERATOR_LABEL}: catalog.ts is stale — re-run the generator\n`);
    return 1;
  }
  writeFileSync(outPath, rendered);
  process.stdout.write(`${GENERATOR_LABEL}: wrote ${outPath}\n`);
  return 0;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
