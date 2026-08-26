import type { AdapterManifest, AdapterPackage } from "@caveman-ai/adapter-kit";
import type {
  EveSessionBinding,
  HarnessAdapter,
  HarnessAdapterIdentity,
} from "@caveman-ai/agent/adapters";

export const manifest: AdapterManifest;
export function createAdapter(
  identity: HarnessAdapterIdentity,
  session: EveSessionBinding,
): HarnessAdapter;
export { createAdapter as createEveAdapter };
declare const adapterPackage: AdapterPackage<typeof createAdapter>;
export default adapterPackage;
