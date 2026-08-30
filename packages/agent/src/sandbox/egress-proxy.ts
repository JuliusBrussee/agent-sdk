/**
 * The parent-owned egress proxy: the enforcement point for scoped network
 * access out of a contained tool.
 *
 * The contained process has **no network stack of its own** (a Linux network
 * namespace with only loopback, or a Seatbelt profile that denies `network*`).
 * Its single reachable peer is this proxy — over a Unix socket that the mount
 * namespace binds in, or over a loopback port the Seatbelt profile names. So
 * the boundary does not depend on the tool cooperating: whatever the tool does,
 * the only bytes that can leave the machine are ones this process dialed.
 *
 * That is the same architecture as `docker run --network none` with a mounted
 * proxy socket, and as a Firecracker guest whose only egress is vsock. It is
 * deliberately *not* the `installNetworkDeny` style of in-process patching,
 * which is bypassable and stays only as a redundant inner layer.
 *
 * Two properties are load-bearing and worth stating plainly:
 *
 * - **No TLS interception.** `CONNECT` is tunnelled byte-for-byte, so the
 *   proxy sees a hostname and never plaintext. It constrains the destination,
 *   not the payload; domain fronting defeats it. Terminating TLS here would
 *   mean minting a CA the tool trusts, which trades one risk for a worse one.
 * - **The tool never holds the credential.** Provider keys stay in the parent
 *   (`sandbox-credentials.ts`); a tool that needs an authenticated API gets it
 *   through a tool, not through egress.
 *
 * Denials are counted, not just refused, so a run's receipt can carry honest
 * evidence of what the tool tried to reach.
 */

import { createServer, connect, type Server, type Socket } from "node:net";
import { request as httpRequest } from "node:http";
import { egressAllowed, parseEgressTarget, type ResolvedEgressPolicy } from "./policy.js";

export interface EgressAttempt {
  readonly host: string;
  readonly port: number;
  readonly allowed: boolean;
}

export interface EgressProxy {
  /** `http://127.0.0.1:<port>` — what the child sets as `HTTP(S)_PROXY`. */
  readonly url: string;
  /** Unix socket path, for a child whose namespace has no route to loopback. */
  readonly socketPath: string;
  /** Every target the child asked for, in order, allowed or not. */
  attempts(): readonly EgressAttempt[];
  close(): Promise<void>;
}

/** Hard ceiling on concurrent tunnels, so one tool cannot exhaust host fds. */
const MAX_CONNECTIONS = 64;
/** A tunnel with no traffic in either direction is reaped. */
const IDLE_MS = 120_000;
const MAX_REQUEST_HEAD_BYTES = 16 * 1024;

function refuse(socket: Socket, status: string): void {
  socket.end(`HTTP/1.1 ${status}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
}

/**
 * Start the proxy. Binds both a loopback port and `socketPath`: which one the
 * child uses is a property of its sandbox backend, not of the policy, and
 * binding both keeps the backends from each needing their own proxy.
 */
export async function startEgressProxy(
  policy: ResolvedEgressPolicy,
  socketPath: string,
): Promise<EgressProxy> {
  const attempts: EgressAttempt[] = [];
  let open = 0;

  const onConnection = (client: Socket): void => {
    if (open >= MAX_CONNECTIONS) {
      refuse(client, "429 Too Many Requests");
      return;
    }
    open += 1;
    client.once("close", () => { open -= 1; });
    client.on("error", () => client.destroy());
    client.setTimeout(IDLE_MS, () => client.destroy());

    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      head = Buffer.concat([head, chunk]);
      if (head.byteLength > MAX_REQUEST_HEAD_BYTES) {
        client.removeListener("data", onData);
        refuse(client, "431 Request Header Fields Too Large");
        return;
      }
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) return;
      client.removeListener("data", onData);
      client.pause();
      dispatch(head.subarray(0, end + 4).toString("latin1"), head.subarray(end + 4), client);
    };
    client.on("data", onData);
  };

  const dispatch = (rawHead: string, rest: Buffer, client: Socket): void => {
    const requestLine = rawHead.split("\r\n", 1)[0] ?? "";
    const [method, target] = requestLine.split(" ");
    if (method === "CONNECT") {
      tunnel(target ?? "", rest, client);
      return;
    }
    // Absolute-form plaintext (`GET http://host/path HTTP/1.1`). Same
    // allowlist decision, then a plain relay. Supported so an `http://` API is
    // not a silent dead end that pushes callers back to unbounded egress.
    forward(rawHead, target ?? "", rest, client);
  };

  const decide = (authority: string, defaultPort: number):
    { host: string; port: number } | undefined => {
    const parsed = parseEgressTarget(authority, defaultPort);
    if (parsed === undefined) return undefined;
    const allowed = egressAllowed(policy, parsed.host, parsed.port);
    if (attempts.length < 1000) {
      attempts.push(Object.freeze({ ...parsed, allowed }));
    }
    return allowed ? parsed : undefined;
  };

  const tunnel = (authority: string, rest: Buffer, client: Socket): void => {
    const target = decide(authority, 443);
    if (target === undefined) {
      refuse(client, "403 Forbidden");
      return;
    }
    const upstream = connect(target.port, target.host);
    upstream.setTimeout(IDLE_MS, () => upstream.destroy());
    upstream.once("error", () => {
      upstream.destroy();
      if (client.writable) refuse(client, "502 Bad Gateway");
    });
    upstream.once("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (rest.byteLength > 0) upstream.write(rest);
      client.resume();
      client.pipe(upstream);
      upstream.pipe(client);
    });
    client.once("close", () => upstream.destroy());
  };

  const forward = (rawHead: string, target: string, rest: Buffer, client: Socket): void => {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(target);
    } catch {
      refuse(client, "400 Bad Request");
      return;
    }
    if (parsedUrl.protocol !== "http:") {
      refuse(client, "403 Forbidden");
      return;
    }
    const decided = decide(parsedUrl.host, 80);
    if (decided === undefined) {
      refuse(client, "403 Forbidden");
      return;
    }
    const lines = rawHead.split("\r\n").slice(1).filter((line) => line.length > 0);
    const headers: Record<string, string> = {};
    for (const line of lines) {
      const colon = line.indexOf(":");
      if (colon <= 0) continue;
      const name = line.slice(0, colon).trim().toLowerCase();
      // Hop-by-hop headers are the proxy's business, not the origin's.
      if (name === "proxy-connection" || name === "connection" ||
          name === "proxy-authorization" || name === "keep-alive") continue;
      headers[name] = line.slice(colon + 1).trim();
    }
    const method = rawHead.split(" ", 1)[0] ?? "GET";
    const upstream = httpRequest({
      host: decided.host,
      port: decided.port,
      method,
      path: `${parsedUrl.pathname}${parsedUrl.search}`,
      headers,
    });
    upstream.setTimeout(IDLE_MS, () => upstream.destroy());
    upstream.once("error", () => {
      if (client.writable) refuse(client, "502 Bad Gateway");
    });
    upstream.once("response", (response) => {
      const status = `HTTP/1.1 ${response.statusCode ?? 502} ${response.statusMessage ?? ""}\r\n`;
      const raw = Object.entries(response.headers)
        .flatMap(([name, value]) =>
          (Array.isArray(value) ? value : [value ?? ""]).map((item) => `${name}: ${item}\r\n`))
        .join("");
      client.write(`${status}${raw}\r\n`);
      response.pipe(client);
    });
    if (rest.byteLength > 0) upstream.write(rest);
    client.resume();
    client.pipe(upstream);
    client.once("close", () => upstream.destroy());
  };

  const listen = (server: Server, target: number | string): Promise<void> =>
    new Promise((accept, reject) => {
      server.once("error", reject);
      server.listen(target, () => {
        server.removeListener("error", reject);
        accept();
      });
    });

  const loopback = createServer(onConnection);
  const unix = createServer(onConnection);
  await listen(loopback, 0);
  try {
    await listen(unix, socketPath);
  } catch (error) {
    loopback.close();
    throw error;
  }
  const address = loopback.address();
  if (address === null || typeof address === "string") {
    loopback.close();
    unix.close();
    throw new Error("cave_sandbox_egress_proxy_bind_failed");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    socketPath,
    attempts: () => attempts.slice(),
    close: async () => {
      await Promise.all([loopback, unix].map((server) =>
        new Promise<void>((accept) => server.close(() => accept()))));
    },
  };
}
