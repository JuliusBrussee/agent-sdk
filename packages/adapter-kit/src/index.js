const CAPABILITY_NAMES = Object.freeze([
  "run",
  "stream",
  "tools",
  "usage",
  "abort",
  "durable",
  "compile",
]);

const CAPABILITY_STATES = Object.freeze([
  "unsupported",
  "experimental",
  "certified",
]);

const MANIFEST_KEYS = Object.freeze([
  "schemaVersion",
  "id",
  "packageName",
  "adapterVersion",
  "upstream",
  "capabilities",
  "certifications",
]);

const CERTIFICATION_SUITE = "@caveman-ai/adapter-conformance/v1";
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PACKAGE_NAME = /^@caveman-ai\/[a-z0-9][a-z0-9-]{0,95}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,127}$/;
const HEX_64 = /^[0-9a-f]{64}$/;

export const ADAPTER_CAPABILITIES = CAPABILITY_NAMES;
export const ADAPTER_CAPABILITY_STATES = CAPABILITY_STATES;
export const ADAPTER_CONFORMANCE_SUITE = CERTIFICATION_SUITE;

export function defineAdapterManifest(value) {
  if (!isRecord(value) || !exactKeys(value, MANIFEST_KEYS) ||
      value.schemaVersion !== 1 || !ID.test(value.id) ||
      !PACKAGE_NAME.test(value.packageName) || !VERSION.test(value.adapterVersion) ||
      !isRecord(value.upstream) || !exactKeys(value.upstream, ["package", "version"]) ||
      typeof value.upstream.package !== "string" || value.upstream.package.length === 0 ||
      !VERSION.test(value.upstream.version) || !isRecord(value.capabilities) ||
      !exactKeys(value.capabilities, CAPABILITY_NAMES) || !isRecord(value.certifications)) {
    throw new Error("cave_adapter_manifest_invalid");
  }

  for (const capability of CAPABILITY_NAMES) {
    const state = value.capabilities[capability];
    if (!CAPABILITY_STATES.includes(state)) {
      throw new Error(`cave_adapter_capability_state_invalid:${capability}`);
    }
    const certification = value.certifications[capability];
    if (state === "certified") {
      validateCertification(capability, certification);
    } else if (certification !== undefined) {
      throw new Error(`cave_adapter_certification_without_capability:${capability}`);
    }
  }

  if (Object.keys(value.certifications).some((name) => !CAPABILITY_NAMES.includes(name))) {
    throw new Error("cave_adapter_certification_unknown_capability");
  }
  return deepFreeze(structuredClone(value));
}

export function defineAdapterPackage(value) {
  if (!isRecord(value) || !exactKeys(value, ["manifest", "createAdapter"]) ||
      typeof value.createAdapter !== "function") {
    throw new Error("cave_adapter_package_invalid");
  }
  return Object.freeze({
    manifest: defineAdapterManifest(value.manifest),
    createAdapter: value.createAdapter,
  });
}

export function createAdapterRegistry() {
  const packagesByID = new Map();
  const idsByPackage = new Map();

  return Object.freeze({
    register(value) {
      const adapterPackage = defineAdapterPackage(value);
      const { id, packageName } = adapterPackage.manifest;
      if (packagesByID.has(id) || idsByPackage.has(packageName)) {
        throw new Error(`cave_adapter_duplicate:${id}`);
      }
      packagesByID.set(id, adapterPackage);
      idsByPackage.set(packageName, id);
      return adapterPackage;
    },
    get(id) {
      return packagesByID.get(id);
    },
    require(id, capability) {
      if (!CAPABILITY_NAMES.includes(capability)) {
        throw new Error(`cave_adapter_capability_unknown:${String(capability)}`);
      }
      const adapterPackage = packagesByID.get(id);
      if (adapterPackage === undefined) {
        throw new Error(`cave_adapter_unknown:${id}`);
      }
      const state = adapterPackage.manifest.capabilities[capability];
      if (state !== "certified") {
        throw new Error(`cave_adapter_capability_not_certified:${id}:${capability}:${state}`);
      }
      return adapterPackage;
    },
    list() {
      return Object.freeze(
        [...packagesByID.values()]
          .sort((left, right) => left.manifest.id.localeCompare(right.manifest.id)),
      );
    },
  });
}

function validateCertification(capability, value) {
  if (!isRecord(value) || !exactKeys(value, ["suite", "reportSHA256"]) ||
      value.suite !== CERTIFICATION_SUITE || !HEX_64.test(value.reportSHA256)) {
    throw new Error(`cave_adapter_certification_invalid:${capability}`);
  }
}

function exactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return actual.length === canonical.length &&
    actual.every((key, index) => key === canonical[index]);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
