import type { AdapterCapability } from "@caveman-ai/adapter-kit";

export const ADAPTER_CONFORMANCE_CANDIDATE_SUITE:
  "@caveman-ai/adapter-conformance/candidate/v4";
export const ADAPTER_CONFORMANCE_REPORT_SCHEMA:
  "caveman.adapter-conformance.report.v4";

export type ConformanceResultStatus = "passed" | "failed" | "skipped";

export interface CanonicalConformanceCaseDefinition {
  readonly capability: AdapterCapability;
  readonly id: string;
}

export interface ConformanceThreshold {
  readonly operator: "lte";
  readonly value: number;
}

export interface CanonicalConformancePerformanceDefinition {
  readonly capability: AdapterCapability;
  readonly id: string;
  readonly metric: "hook-overhead-p99";
  readonly unit: "microseconds";
  readonly clock: "node:process.hrtime.bigint:captured";
  readonly percentile: 99;
  readonly warmupCount: number;
  readonly sampleCount: number;
  readonly threshold: ConformanceThreshold;
}

export interface CanonicalConformanceTestVector {
  readonly id: "adapter-capabilities-v4";
  readonly version: "4.0.0";
  readonly cases: readonly CanonicalConformanceCaseDefinition[];
  readonly performance: readonly CanonicalConformancePerformanceDefinition[];
  readonly sha256: string;
}

export const ADAPTER_CONFORMANCE_TEST_VECTOR: CanonicalConformanceTestVector;

export interface ConformanceAdapterMetadata {
  readonly id: string;
  readonly packageName: string;
  readonly version: string;
}

export interface ConformanceUpstreamMetadata {
  readonly packageName: string;
  readonly version: string;
}

export interface ConformanceEnvironment {
  readonly runtime: { readonly name: "node"; readonly version: string };
  readonly platform: { readonly name: string; readonly architecture: string };
  readonly execution: "uncontained-host";
}

export interface ConformanceArtifactBytes {
  readonly adapter: Uint8Array;
  readonly upstream: Uint8Array;
}

export interface ConformancePackageMetadata {
  readonly role: "adapter" | "upstream";
  readonly name: string;
  readonly version: string;
  readonly sha256: string;
}

export interface ConformanceCaseVector {
  readonly id: string;
  readonly capability: AdapterCapability;
  readonly testVectorSHA256: string;
}

export type ConformanceCaseResult =
  | { readonly status: "passed"; readonly evidence: Uint8Array }
  | { readonly status: "failed" | "skipped"; readonly code: string };

export interface ConformanceCase {
  readonly id: string;
  readonly run: (
    vector: ConformanceCaseVector,
  ) => ConformanceCaseResult | Promise<ConformanceCaseResult>;
}

export type ConformancePerformanceInput =
  | {
      readonly id: string;
      readonly run: (vector: ConformanceCaseVector) => void;
    }
  | { readonly id: string; readonly skipped: { readonly code: string } };

export interface AdapterConformanceInput {
  readonly adapter: ConformanceAdapterMetadata;
  readonly upstream: ConformanceUpstreamMetadata;
  readonly artifacts: ConformanceArtifactBytes;
  readonly capabilities: readonly AdapterCapability[];
  readonly cases: readonly ConformanceCase[];
  readonly performance: readonly ConformancePerformanceInput[];
}

export interface ConformanceCounts {
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly total: number;
}

export interface ConformanceCaseOutput {
  readonly id: string;
  readonly status: ConformanceResultStatus;
  readonly code: string | null;
  readonly evidenceSHA256: string | null;
}

export interface ConformancePerformanceOutput {
  readonly id: string;
  readonly capability: AdapterCapability;
  readonly metric: "hook-overhead-p99";
  readonly unit: "microseconds";
  readonly clock: "node:process.hrtime.bigint:captured";
  readonly percentile: 99;
  readonly warmupCount: number;
  readonly requiredSampleCount: number;
  readonly sampleCount: number;
  readonly observed: number | null;
  readonly threshold: ConformanceThreshold;
  readonly status: ConformanceResultStatus;
  readonly code: string | null;
}

export interface ConformanceCapabilityOutput {
  readonly name: AdapterCapability;
  readonly cases: readonly ConformanceCaseOutput[];
  readonly caseCounts: ConformanceCounts;
  readonly performanceCounts: ConformanceCounts;
  readonly qualification: {
    readonly status: "passed" | "blocked";
    readonly blockers: readonly string[];
  };
}

export interface AdapterConformanceReport {
  readonly schema: typeof ADAPTER_CONFORMANCE_REPORT_SCHEMA;
  readonly suite: typeof ADAPTER_CONFORMANCE_CANDIDATE_SUITE;
  readonly adapter: ConformanceAdapterMetadata;
  readonly upstream: ConformanceUpstreamMetadata;
  readonly environment: ConformanceEnvironment;
  readonly packages: readonly [
    ConformancePackageMetadata & { readonly role: "adapter" },
    ConformancePackageMetadata & { readonly role: "upstream" },
  ];
  readonly testVector: {
    readonly id: typeof ADAPTER_CONFORMANCE_TEST_VECTOR.id;
    readonly version: typeof ADAPTER_CONFORMANCE_TEST_VECTOR.version;
    readonly sha256: string;
    readonly executedSetSHA256: string;
  };
  readonly capabilities: readonly ConformanceCapabilityOutput[];
  readonly performance: readonly ConformancePerformanceOutput[];
  readonly totals: {
    readonly capabilities: {
      readonly passed: number;
      readonly blocked: number;
      readonly total: number;
    };
    readonly cases: ConformanceCounts;
    readonly performance: ConformanceCounts;
  };
  readonly reportDigest: `sha256:${string}`;
}

export function canonicalSerialize(value: unknown): string;
export function computeArtifactSHA256(bytes: Uint8Array): string;
export function createNodeConformanceEnvironment(): ConformanceEnvironment;
export function runAdapterConformance(
  input: AdapterConformanceInput,
): Promise<AdapterConformanceReport>;
export function defineConformanceReport(
  value: AdapterConformanceReport,
): AdapterConformanceReport;
export function computeConformanceReportDigest(
  value: AdapterConformanceReport | Omit<AdapterConformanceReport, "reportDigest">,
): `sha256:${string}`;
