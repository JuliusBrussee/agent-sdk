/**
 * OS containment backends: one contract, one implementation per kernel
 * mechanism, and a selector that fails closed.
 *
 * Everything platform-specific about spawning a contained tool lives here, so
 * `runtime.ts` asks for a containment level and never learns what a Seatbelt
 * profile or a bubblewrap argument looks like. Adding a backend (a container
 * runtime, a microVM) is a new object in this file, not a new branch in the
 * agent loop.
 *
 * Capabilities are declared, not assumed. A backend that cannot contain
 * AF_UNIX egress says so, and a caller that needs that containment gets a
 * refusal instead of a weaker sandbox wearing the same name. This matters
 * because the weakest backend here (`unshare`, no mount namespace) genuinely
 * cannot hide `/var/run/docker.sock` from tool code, and pretending otherwise
 * would be the exact "sandbox that claims more than it enforces" bug the
 * threat model forbids.
 *
 * Strength order, strongest first: `bubblewrap` (mount + net + pid + user
 * namespaces), `seatbelt` (kernel policy, whole-filesystem view but no
 * network), `unshare` (net namespace only).
 */

import { spawnSync } from "node:child_process";

export type SandboxBackendId = "bubblewrap" | "seatbelt" | "unshare";

export interface SandboxContainment {
  /** Can the backend deny AF_UNIX connects to host sockets (docker.sock)? */
  readonly unixSocketEgress: boolean;
  /** Can the backend give the child a reachable, policy-scoped egress path? */
  readonly scopedEgress: boolean;
  /** Does the child see a filesystem view narrowed by the kernel, not by Node? */
  readonly mountNamespace: boolean;
}

export interface SandboxSpawnRequest {
  /** Everything after the node binary: `--permission`, flags, worker path. */
  readonly nodeArgs: readonly string[];
  /** Ephemeral writable directory. Bound in; everything else stays read-only. */
  readonly workspace: string;
  /**
   * Unix socket of the parent egress proxy, or undefined for no egress at all.
   * Present only when the selected policy permits some destination.
   */
  readonly egressSocketPath?: string;
}

export interface SandboxSpawnPlan {
  readonly command: string;
  readonly args: readonly string[];
  /**
   * How the child reaches the proxy. `"socket"` means it must bridge the Unix
   * socket to a loopback port itself (its namespace has no route to the
   * parent's loopback); `"loopback"` means the parent's port is directly
   * reachable; `"none"` means there is no egress.
   */
  readonly egress: "socket" | "loopback" | "none";
}

export interface SandboxBackend {
  readonly id: SandboxBackendId;
  readonly containment: SandboxContainment;
  /** True when this kernel mechanism is usable on this host, right now. */
  available(): boolean;
  plan(request: SandboxSpawnRequest): SandboxSpawnPlan;
}

/** Where the proxy socket appears inside a mount-namespaced child. */
const GUEST_EGRESS_SOCKET = "/run/cave-egress.sock";

let bubblewrapProbe: string | undefined | null = null;

/** Absolute path to a working `bwrap`, or undefined. Probed once per process. */
function findBubblewrap(): string | undefined {
  if (bubblewrapProbe !== null) return bubblewrapProbe;
  bubblewrapProbe = undefined;
  for (const candidate of ["/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap"]) {
    const probe = spawnSync(candidate, ["--version"], { stdio: "ignore" });
    if (probe.error === undefined && probe.status === 0) {
      bubblewrapProbe = candidate;
      break;
    }
  }
  return bubblewrapProbe;
}

/**
 * Linux, strongest. A mount namespace is what closes the AF_UNIX hole: the
 * child cannot connect to a host socket it cannot see. `--unshare-all` also
 * brings up a private loopback, which is what makes the in-child bridge to the
 * proxy socket possible at all.
 *
 * The filesystem view is `/` read-only with the socket-bearing and home-like
 * directories replaced by empty tmpfs. Read *granularity* stays Node's
 * permission model (`--allow-fs-read`), which is finer than any bind set we
 * could assemble portably across distro layouts; bwrap supplies the namespace
 * containment that the permission model has no concept of.
 */
const bubblewrap: SandboxBackend = {
  id: "bubblewrap",
  containment: { unixSocketEgress: true, scopedEgress: true, mountNamespace: true },
  available: () => process.platform === "linux" && findBubblewrap() !== undefined,
  plan(request) {
    const command = findBubblewrap();
    if (command === undefined) throw new Error("cave_sandbox_backend_unavailable");
    const args = [
      "--unshare-all",
      "--die-with-parent",
      "--new-session",
      "--ro-bind", "/", "/",
      "--dev", "/dev",
      "--proc", "/proc",
      // Order matters: the tmpfs must land before anything is bound into it.
      // These are the directories that hold host unix sockets and user
      // secrets. Emptying them is the whole point of taking a mount namespace.
      "--tmpfs", "/run",
      "--tmpfs", "/var/run",
      "--tmpfs", "/tmp",
      "--tmpfs", "/root",
      "--tmpfs", "/home",
      "--bind", request.workspace, request.workspace,
    ];
    if (request.egressSocketPath !== undefined) {
      args.push("--bind", request.egressSocketPath, GUEST_EGRESS_SOCKET);
    }
    args.push(process.execPath, "--no-addons", ...request.nodeArgs);
    return Object.freeze({
      command,
      args: Object.freeze(args),
      egress: request.egressSocketPath === undefined ? "none" : "socket",
    });
  },
};

/**
 * macOS. Seatbelt denies the whole `network*` class — which covers AF_UNIX
 * connects as well as IP — and then re-allows exactly the parent's loopback
 * proxy port. There is no mount namespace, so the read restriction is Node's
 * permission model alone; the unix-socket hole is closed by policy rather than
 * by hiding the path.
 */
const seatbelt: SandboxBackend = {
  id: "seatbelt",
  containment: { unixSocketEgress: true, scopedEgress: true, mountNamespace: false },
  available: () => process.platform === "darwin",
  plan(request) {
    const profile = [
      "(version 1)",
      "(allow default)",
      "(deny network*)",
    ];
    if (request.egressSocketPath !== undefined) {
      // Loopback to the proxy only. The port is not known here, so the child
      // is allowed the loopback interface and nothing else; the proxy itself
      // is the destination filter.
      profile.push('(allow network-outbound (remote ip "localhost:*"))');
    }
    return Object.freeze({
      command: "/usr/bin/sandbox-exec",
      args: Object.freeze([
        "-p", profile.join(""),
        process.execPath,
        "--no-addons",
        ...request.nodeArgs,
      ]),
      egress: request.egressSocketPath === undefined ? "none" : "loopback",
    });
  },
};

/**
 * Linux fallback when bubblewrap is absent. A network namespace and nothing
 * else: no IP egress, but also no mount namespace, so host unix sockets stay
 * visible and reachable. Declared honestly, and refused whenever the caller
 * needs either containment it lacks.
 */
const unshare: SandboxBackend = {
  id: "unshare",
  containment: { unixSocketEgress: false, scopedEgress: false, mountNamespace: false },
  available: () => process.platform === "linux",
  plan(request) {
    if (request.egressSocketPath !== undefined) {
      throw new Error("cave_sandbox_backend_scoped_egress_unavailable");
    }
    return Object.freeze({
      command: "/usr/bin/unshare",
      args: Object.freeze([
        "--user", "--map-root-user", "--net", "--",
        process.execPath, "--no-addons", ...request.nodeArgs,
      ]),
      egress: "none",
    });
  },
};

export const SANDBOX_BACKENDS: readonly SandboxBackend[] =
  Object.freeze([bubblewrap, seatbelt, unshare]);

export interface SandboxBackendNeed {
  /** True when the tool has an egress policy that must actually be reachable. */
  readonly scopedEgress: boolean;
  /**
   * Require AF_UNIX containment. Defaults to the honest position — off — so
   * existing Linux hosts without bubblewrap keep working exactly as before,
   * with the gap named in the threat model rather than newly fatal.
   */
  readonly unixSocketEgress?: boolean;
}

/**
 * The strongest available backend that meets `need`, or a refusal. Never
 * silently downgrades: a caller that asked for scoped egress and gets a
 * backend without it would believe in a boundary that is not there.
 */
export function selectSandboxBackend(need: SandboxBackendNeed): SandboxBackend {
  for (const backend of SANDBOX_BACKENDS) {
    if (!backend.available()) continue;
    if (need.scopedEgress && !backend.containment.scopedEgress) continue;
    if (need.unixSocketEgress === true && !backend.containment.unixSocketEgress) continue;
    return backend;
  }
  throw new Error(
    need.scopedEgress
      ? "cave_sandbox_scoped_egress_unavailable"
      : "cave_sandbox_os_network_isolation_unavailable",
  );
}
