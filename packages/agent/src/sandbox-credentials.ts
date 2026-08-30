// Credential allowlist for isolated tool children. Split out of runtime.ts:
// this is a security policy with no runtime coupling, and it should be
// reviewable — and testable — without reading the agent loop.

// Live-eval profiles are repository-controlled input. They must not turn the
// parent CI environment into a secret broker by naming arbitrary variables.
// These are the only provider credentials a live tool may receive. Keep the
// mapping in the runtime (not just the CLI loader) because callers can invoke
// runAgentInternal directly, and keep one provider family per profile so a
// profile cannot harvest every provider credential in the parent job.
export const SANDBOX_CREDENTIAL_ENV_BY_CAPABILITY = Object.freeze({
  anthropic: Object.freeze(["ANTHROPIC_API_KEY"]),
  openai: Object.freeze(["OPENAI_API_KEY"]),
  google: Object.freeze(["GEMINI_API_KEY", "GOOGLE_API_KEY"]),
});

export type SandboxCredentialCapability = keyof typeof SANDBOX_CREDENTIAL_ENV_BY_CAPABILITY;

const SANDBOX_CREDENTIAL_ENV_TO_CAPABILITY = new Map<string, SandboxCredentialCapability>(
  Object.entries(SANDBOX_CREDENTIAL_ENV_BY_CAPABILITY).flatMap(([capability, names]) =>
    names.map((name) => [name, capability as SandboxCredentialCapability]),
  ),
);

// Explicitly document the high-impact families that are never eligible. Names
// outside the provider map are denied too; the prefixes make that deny rule
// durable if the provider map grows later.
const SANDBOX_CREDENTIAL_DENY_PREFIXES = [
  "AWS_",
  "AZURE_",
  "BOOTSTRAP_",
  "CAVE_",
  "CAVEBENCH_",
  "CLOUD_",
  "COSIGN_",
  "DATABASE_",
  "DB_",
  "DEPLOY_",
  "GCP_",
  "GOOGLE_APPLICATION_",
  "GOOGLE_CLOUD_",
  "GITHUB_",
  "KMS_",
  "MINIO_",
  "PG",
  "POSTGRES_",
  "RECEIPT_",
  "SCW_",
  "SIGN_",
  "STRIPE_",
  "VALKEY_",
].concat(["REDIS_"]);
const SANDBOX_CREDENTIAL_DENY_NAMES = new Set([
  "HOME",
  "LD_PRELOAD",
  "NODE_EXTRA_CA_CERTS",
  "NODE_OPTIONS",
  "PATH",
  "PWD",
  "SHELL",
  "DYLD_INSERT_LIBRARIES",
]);

export function validateSandboxCredentialEnv(names: readonly string[]): void {
  const capabilities = new Set<SandboxCredentialCapability>();
  for (const name of names) {
    const denied = typeof name === "string" &&
      (SANDBOX_CREDENTIAL_DENY_NAMES.has(name) ||
        SANDBOX_CREDENTIAL_DENY_PREFIXES.some((prefix) => name.startsWith(prefix)));
    const capability = denied || typeof name !== "string"
      ? undefined
      : SANDBOX_CREDENTIAL_ENV_TO_CAPABILITY.get(name);
    if (capability === undefined) {
      // Keep profile-controlled names out of errors. This is a policy result,
      // not a diagnostic surface, and the name may itself identify a secret.
      throw new Error("cave_sandbox_credential_env_not_allowlisted");
    }
    capabilities.add(capability);
  }
  if (capabilities.size > 1) {
    throw new Error("cave_sandbox_credential_capability_ambiguous");
  }
}

/** Build the complete environment for an isolated tool child. No spread of
 * `process.env`: only deterministic runtime baseline plus an exact provider
 * capability selected by the validated live profile.
 *
 * `additions` are framework-minted, never profile-controlled: the scoped-egress
 * proxy address and its Node opt-in flag. They are applied last and are the
 * only names allowed to bypass the capability allowlist, because they carry no
 * secret — a loopback URL is not a credential. Anything a caller tries to smuggle
 * in under a credential-shaped name is still refused here. */
export function buildSandboxToolEnv(
  names: readonly string[] = [],
  additions: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  validateSandboxCredentialEnv(names);
  const env: NodeJS.ProcessEnv = {
    LANG: process.env.LANG ?? "C",
    LC_ALL: process.env.LC_ALL ?? "C",
    PATH: process.env.PATH ?? "",
    TZ: process.env.TZ ?? "UTC",
    CAVE_EVAL_FIXTURE: "1",
  };
  for (const name of names) {
    const value = process.env[name];
    if (value === undefined) throw new Error("cave_sandbox_credential_missing");
    env[name] = value;
  }
  return mergeSandboxToolEnv(env, additions);
}

/**
 * Merge framework-minted, non-secret names into an already-built child env.
 * Separate from {@link buildSandboxToolEnv} because the egress proxy address is
 * not known until after the credential grant has been validated — and that
 * validation must happen before any per-call state is allocated, so a refused
 * profile leaves no workspace and no listening socket behind.
 */
export function mergeSandboxToolEnv(
  base: NodeJS.ProcessEnv,
  additions: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const [name, value] of Object.entries(additions)) {
    if (!SANDBOX_FRAMEWORK_ENV.has(name)) {
      throw new Error("cave_sandbox_env_addition_not_allowlisted");
    }
    env[name] = value;
  }
  return env;
}

/** The exact non-secret names the framework may add. Closed set on purpose. */
const SANDBOX_FRAMEWORK_ENV = new Set([
  "CAVE_EGRESS_MODE",
  "NODE_USE_ENV_PROXY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
]);
