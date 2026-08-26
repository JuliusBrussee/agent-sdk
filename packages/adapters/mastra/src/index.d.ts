import type { AdapterManifest, AdapterPackage } from "@caveman-ai/adapter-kit";
import type {
  HarnessAdapter,
  HarnessAdapterIdentity,
  MastraAdapterOptions,
  MastraAgentBinding,
} from "@caveman-ai/agent/adapters";

export const manifest: AdapterManifest;
export function createAdapter(
  identity: HarnessAdapterIdentity,
  agent: MastraAgentBinding,
  options?: MastraAdapterOptions,
): HarnessAdapter;
export { createAdapter as createMastraAdapter };
declare const adapterPackage: AdapterPackage<typeof createAdapter>;
export default adapterPackage;
