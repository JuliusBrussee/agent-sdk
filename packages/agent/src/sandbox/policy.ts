/**
 * Declarative sandbox egress policy: which hosts a contained tool may reach.
 *
 * Every serious agent sandbox converged on the same shape — a JSON allowlist of
 * domains, enforced by a proxy the sandboxed code cannot bypass (Anthropic's
 * sandbox-runtime, Codex's network proxy, Docker `--network none` plus a
 * mounted socket, Firecracker plus vsock). This file is the policy half: pure
 * data and pure matching, no I/O, so the rule that decides whether bytes leave
 * the machine is reviewable on its own.
 *
 * The matching rules are deliberately strict, because the known real-world
 * break in this class of allowlist was a *parsing* bug, not a policy bug: a
 * SOCKS5 hostname containing a NUL byte matched `*.example.com` by string
 * suffix while the resolver used only the prefix before the NUL. So:
 *
 * - hostnames are matched **label-wise**, never by string suffix;
 * - any byte outside LDH + `.` + `-` rejects the host before matching;
 * - `*.` is the only wildcard, only leading, and never matches the apex;
 * - the port is part of the decision, not an afterthought.
 *
 * What this policy cannot do is named honestly in one place: the proxy sees the
 * client-supplied hostname and a CONNECT tunnel it does not terminate. It has
 * no TLS interception, so it constrains *who the client says it is dialing*,
 * not the bytes inside. Domain fronting defeats it. That is the same ceiling
 * every non-intercepting egress allowlist has.
 */

/** A tool's requested egress. `"none"` is the default and the safe value. */
export type SandboxEgress = "none" | SandboxEgressPolicy;

export interface SandboxEgressPolicy {
  /**
   * Hosts the tool may dial. Exact (`api.example.com`) or one leading-label
   * wildcard (`*.example.com`, which matches `a.example.com` and
   * `a.b.example.com` but never `example.com` itself).
   */
  readonly allowedHosts: readonly string[];
  /** Ports the tool may dial. Defaults to `[443]` when omitted. */
  readonly allowedPorts?: readonly number[];
}

export interface ResolvedEgressPolicy {
  readonly allowedHosts: readonly string[];
  readonly allowedPorts: readonly number[];
}

const MAX_HOSTS = 256;
const MAX_HOST_BYTES = 253;
const MAX_LABEL_BYTES = 63;
/** LDH: letters, digits, hyphen. No underscores, no NUL, no unicode, no IDN. */
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

function validLabels(host: string): readonly string[] | undefined {
  if (host.length === 0 || host.length > MAX_HOST_BYTES) return undefined;
  if (host !== host.toLowerCase()) return undefined;
  const labels = host.split(".");
  if (labels.length < 2) return undefined;
  for (const label of labels) {
    if (label.length > MAX_LABEL_BYTES || !LABEL.test(label)) return undefined;
  }
  return labels;
}

/**
 * Normalize and validate a policy. Throws rather than silently narrowing: a
 * policy the caller cannot parse is a policy the caller cannot reason about.
 */
export function resolveEgressPolicy(policy: SandboxEgressPolicy): ResolvedEgressPolicy {
  if (!Array.isArray(policy.allowedHosts) || policy.allowedHosts.length === 0) {
    throw new Error("cave_sandbox_egress_policy_empty");
  }
  if (policy.allowedHosts.length > MAX_HOSTS) {
    throw new Error("cave_sandbox_egress_policy_too_large");
  }
  const hosts: string[] = [];
  for (const entry of policy.allowedHosts) {
    if (typeof entry !== "string") throw new Error("cave_sandbox_egress_host_invalid");
    const wildcard = entry.startsWith("*.");
    const host = wildcard ? entry.slice(2) : entry;
    // A second `*` anywhere, a bare `*`, or a NUL/control byte never reaches
    // the matcher: reject the whole policy instead of quietly dropping a rule.
    if (host.includes("*") || validLabels(host) === undefined) {
      throw new Error("cave_sandbox_egress_host_invalid");
    }
    hosts.push(wildcard ? `*.${host}` : host);
  }
  const ports = policy.allowedPorts ?? [443];
  if (!Array.isArray(ports) || ports.length === 0 || ports.length > 16) {
    throw new Error("cave_sandbox_egress_port_invalid");
  }
  for (const port of ports) {
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
      throw new Error("cave_sandbox_egress_port_invalid");
    }
  }
  return Object.freeze({
    allowedHosts: Object.freeze([...new Set(hosts)].sort()),
    allowedPorts: Object.freeze([...new Set(ports)].sort((a, b) => a - b)),
  });
}

/**
 * Does `host:port` satisfy `policy`? The only decision point; the proxy calls
 * exactly this and nothing else, so there is one place to audit.
 */
export function egressAllowed(
  policy: ResolvedEgressPolicy,
  host: string,
  port: number,
): boolean {
  if (!policy.allowedPorts.includes(port)) return false;
  const labels = validLabels(host);
  if (labels === undefined) return false;
  for (const rule of policy.allowedHosts) {
    if (!rule.startsWith("*.")) {
      if (rule === host) return true;
      continue;
    }
    // Label-wise suffix. `*.example.com` accepts `a.example.com` but not
    // `example.com` and not `notexample.com`.
    const ruleLabels = rule.slice(2).split(".");
    if (labels.length <= ruleLabels.length) continue;
    const tail = labels.slice(labels.length - ruleLabels.length);
    if (tail.every((label, index) => label === ruleLabels[index])) return true;
  }
  return false;
}

/**
 * Parse a proxy `CONNECT` authority (`host:port`) or an absolute-form URL
 * authority. Returns undefined for anything ambiguous — a target the proxy
 * cannot parse exactly is never dialed.
 */
export function parseEgressTarget(
  authority: string,
  defaultPort: number,
): { host: string; port: number } | undefined {
  if (typeof authority !== "string" || authority.length === 0 ||
      authority.length > 300 || /[^\x21-\x7e]/.test(authority)) {
    return undefined;
  }
  if (authority.startsWith("[")) return undefined; // no IPv6 literals: not a name
  const colon = authority.lastIndexOf(":");
  const host = colon === -1 ? authority : authority.slice(0, colon);
  const portText = colon === -1 ? String(defaultPort) : authority.slice(colon + 1);
  if (!/^[0-9]{1,5}$/.test(portText)) return undefined;
  const port = Number(portText);
  if (port < 1 || port > 65535) return undefined;
  if (validLabels(host) === undefined) return undefined;
  return { host, port };
}
