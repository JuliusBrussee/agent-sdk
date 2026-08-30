/**
 * The child half of scoped egress. Runs inside the contained tool process,
 * before any tool code is imported.
 *
 * There is deliberately almost nothing here. Node has honoured
 * `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` for `fetch` and for `node:http(s)`
 * since 22.21 when `NODE_USE_ENV_PROXY=1` is set at startup, so the parent
 * sets three environment variables and every HTTP client in the child — the
 * agent's, a dependency's, anything using the platform stack — routes through
 * the parent's allowlist with no patching and nothing to bypass.
 *
 * The one case that needs code is a child in its own network namespace: it has
 * a private loopback but no route to the parent's, so its only reachable peer
 * is the Unix socket bound into its mount namespace. This bridges the two —
 * a loopback listener on a fixed port (private namespace, so the port cannot
 * collide) forwarding byte-for-byte to that socket.
 *
 * This bridge is plumbing, never a boundary. A tool that tears it down or
 * talks to the socket directly gains nothing: the parent proxy is the
 * enforcement point, and the kernel has already removed every other route out.
 */

import { createServer, connect, type Server } from "node:net";

/**
 * Loopback port the in-namespace bridge listens on. Fixed because the parent
 * must name it in `HTTP_PROXY` at spawn time, and safe because the child's
 * network namespace is private to this one tool call.
 */
export const SANDBOX_EGRESS_BRIDGE_PORT = 8118;

/** Where a mount-namespaced backend binds the parent's proxy socket. */
export const SANDBOX_EGRESS_GUEST_SOCKET = "/run/cave-egress.sock";

export const SANDBOX_EGRESS_MODE_ENV = "CAVE_EGRESS_MODE";

/**
 * Environment the parent hands a child that is allowed scoped egress. Nothing
 * here is a secret: it is a loopback address and a mode flag.
 */
export function sandboxEgressEnv(
  mode: "socket" | "loopback",
  proxyUrl: string,
): Record<string, string> {
  const url = mode === "socket"
    ? `http://127.0.0.1:${SANDBOX_EGRESS_BRIDGE_PORT}`
    : proxyUrl;
  return {
    [SANDBOX_EGRESS_MODE_ENV]: mode,
    NODE_USE_ENV_PROXY: "1",
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    // Empty rather than absent: an inherited NO_PROXY would punch a hole in
    // the allowlist by sending some hosts direct, where they would simply fail.
    NO_PROXY: "",
  };
}

/**
 * Start the loopback-to-socket bridge when this child needs one. Resolves once
 * the listener is accepting, so the first tool request cannot race it.
 * Returns undefined when no bridge is needed (`loopback` mode) or when this
 * child has no egress at all.
 */
export function installSandboxEgressBridge(
  env: NodeJS.ProcessEnv = process.env,
): Promise<Server | undefined> {
  if (env[SANDBOX_EGRESS_MODE_ENV] !== "socket") return Promise.resolve(undefined);
  const server = createServer((client) => {
    const upstream = connect(SANDBOX_EGRESS_GUEST_SOCKET);
    client.on("error", () => client.destroy());
    upstream.on("error", () => {
      upstream.destroy();
      client.destroy();
    });
    client.pipe(upstream);
    upstream.pipe(client);
    client.once("close", () => upstream.destroy());
    upstream.once("close", () => client.destroy());
  });
  server.unref();
  return new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(SANDBOX_EGRESS_BRIDGE_PORT, "127.0.0.1", () => {
      server.removeListener("error", reject);
      accept(server);
    });
  });
}
