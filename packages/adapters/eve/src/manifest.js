export const adapterManifest = Object.freeze({
  schemaVersion: 1,
  id: "eve",
  packageName: "@caveman-ai/adapter-eve",
  adapterVersion: "0.1.0",
  upstream: Object.freeze({ package: "eve", version: "0.29.2" }),
  capabilities: Object.freeze({
    run: "experimental",
    stream: "unsupported",
    tools: "experimental",
    usage: "experimental",
    abort: "experimental",
    durable: "experimental",
    compile: "unsupported",
  }),
  certifications: Object.freeze({}),
});
