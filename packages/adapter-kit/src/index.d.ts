export const ADAPTER_CAPABILITIES: readonly [
  "run",
  "stream",
  "tools",
  "usage",
  "abort",
  "durable",
  "compile",
];

export type AdapterCapability = typeof ADAPTER_CAPABILITIES[number];
export type AdapterCapabilityState = "unsupported" | "experimental" | "certified";

export const ADAPTER_CAPABILITY_STATES: readonly AdapterCapabilityState[];
export const ADAPTER_CONFORMANCE_SUITE: "@caveman-ai/adapter-conformance/v1";

export interface AdapterCertification {
  readonly suite: typeof ADAPTER_CONFORMANCE_SUITE;
  readonly reportSHA256: string;
}

export interface AdapterManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly packageName: `@caveman-ai/${string}`;
  readonly adapterVersion: string;
  readonly upstream: {
    readonly package: string;
    readonly version: string;
  };
  readonly capabilities: Readonly<Record<AdapterCapability, AdapterCapabilityState>>;
  readonly certifications: Readonly<Partial<Record<AdapterCapability, AdapterCertification>>>;
}

export interface AdapterPackage<TFactory extends (...args: any[]) => unknown = (...args: any[]) => unknown> {
  readonly manifest: AdapterManifest;
  readonly createAdapter: TFactory;
}

export interface AdapterRegistry {
  register<TFactory extends (...args: any[]) => unknown>(
    value: AdapterPackage<TFactory>,
  ): AdapterPackage<TFactory>;
  get(id: string): AdapterPackage | undefined;
  require(id: string, capability: AdapterCapability): AdapterPackage;
  list(): readonly AdapterPackage[];
}

export function defineAdapterManifest(value: AdapterManifest): AdapterManifest;
export function defineAdapterPackage<TFactory extends (...args: any[]) => unknown>(
  value: AdapterPackage<TFactory>,
): AdapterPackage<TFactory>;
export function createAdapterRegistry(): AdapterRegistry;
