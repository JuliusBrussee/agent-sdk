// In-process network deny: DEFENSE IN DEPTH ONLY, never a boundary. The
// kernel boundary lives in `sandbox/backend.ts`, and the egress allowlist in
// `sandbox/egress-proxy.ts`. This stays because it is a cheap redundant layer
// inside a process that is already contained, and it is bypassable by design
// of the JS runtime — see SANDBOX_THREAT_MODEL.md.
import { createRequire, syncBuiltinESMExports } from "node:module";

const require = createRequire(import.meta.url);

export function installNetworkDeny(): void {
  const denied = () => {
    const error = new Error("cave_sandbox_network_denied");
    (error as NodeJS.ErrnoException).code = "ERR_ACCESS_DENIED";
    throw error;
  };
  globalThis.fetch = denied as typeof globalThis.fetch;
  globalThis.WebSocket = class {
    constructor() {
      denied();
    }
  } as unknown as typeof globalThis.WebSocket;
  for (const name of ["node:http", "node:https", "node:net", "node:tls", "node:dgram", "node:http2", "node:dns"]) {
    const module = require(name) as Record<string, unknown>;
    for (const key of [
      "connect", "createConnection", "createServer", "get", "request", "createSocket",
      "lookup", "resolve", "resolve4", "resolve6", "resolveAny", "reverse",
    ]) {
      if (key in module) {
        try {
          module[key] = denied;
        } catch {
          // CommonJS mutation plus syncBuiltinESMExports covers mutable APIs.
        }
      }
    }
  }
  syncBuiltinESMExports();
}
