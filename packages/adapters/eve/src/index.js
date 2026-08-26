import { defineAdapterPackage } from "@caveman-ai/adapter-kit";
import { createEveAdapter as createCoreAdapter } from "@caveman-ai/agent/adapters";
import { adapterManifest } from "./manifest.js";

const adapterPackage = defineAdapterPackage({
  manifest: adapterManifest,
  createAdapter: createCoreAdapter,
});

export const manifest = adapterPackage.manifest;
export const createAdapter = adapterPackage.createAdapter;
export { createAdapter as createEveAdapter };
export default adapterPackage;
