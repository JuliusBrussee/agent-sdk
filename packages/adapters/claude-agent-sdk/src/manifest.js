export const adapterManifest = Object.freeze({
  schemaVersion: 1,
  id: "claude-agent-sdk",
  packageName: "@caveman-ai/adapter-claude-agent-sdk",
  adapterVersion: "0.1.0",
  upstream: Object.freeze({ package: "@anthropic-ai/claude-agent-sdk", version: "0.3.220" }),
  capabilities: Object.freeze({
    run: "experimental",
    stream: "unsupported",
    tools: "experimental",
    usage: "experimental",
    abort: "experimental",
    durable: "unsupported",
    compile: "unsupported",
  }),
  certifications: Object.freeze({}),
});
