import { readFile } from "node:fs/promises";
import { findPackageJSONCompat } from "./node-compat.js";

/**
 * Optional peers back subpath exports only, so a default install never
 * downloads them. Naming the lane matters: a missing peer otherwise surfaces
 * as a bare ERR_MODULE_NOT_FOUND from a file the caller never imported.
 */
const PEER_LANE: Readonly<Record<string, string>> = {
  "@anthropic-ai/claude-agent-sdk": "@caveman-ai/agent/claude",
  zod: "@caveman-ai/agent/claude",
};

export type OptionalPeer = {
  readonly name: string;
  readonly range: string;
  readonly lane: string;
  readonly installed: boolean;
};

type PeerManifest = {
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

/**
 * Declared optional peers and whether each resolves from this installation.
 * Resolution only: importing would execute a provider client just to learn
 * whether it is present.
 */
export async function optionalPeerStatus(): Promise<OptionalPeer[]> {
  const manifestURL = new URL("../package.json", import.meta.url);
  const manifest = JSON.parse(await readFile(manifestURL, "utf8")) as PeerManifest;
  const meta = manifest.peerDependenciesMeta ?? {};
  return Object.entries(manifest.peerDependencies ?? {})
    .filter(([name]) => meta[name]?.optional === true)
    .map(([name, range]) => ({
      name,
      range,
      lane: PEER_LANE[name] ?? name,
      installed: findPackageJSONCompat(name, manifestURL) !== undefined,
    }));
}

/** Doctor check: which optional lanes this installation can actually reach. */
export async function optionalPeerCheck(): Promise<{
  id: string;
  status: "pass" | "warn";
  detail: string;
  fix?: string;
}> {
  const peers = await optionalPeerStatus();
  const missing = peers.filter((peer) => !peer.installed);
  if (missing.length === 0) {
    return {
      id: "optional_peers",
      status: "pass",
      detail: peers.length === 0
        ? "no optional peers declared"
        : `optional peers installed: ${peers.map((peer) => peer.name).join(", ")}`,
    };
  }
  return {
    id: "optional_peers",
    status: "warn",
    detail: `${[...new Set(missing.map((peer) => peer.lane))].join(", ")} unavailable until ${
      missing.length > 1 ? "its optional peers are" : "its optional peer is"
    } installed: ${missing.map((peer) => peer.name).join(", ")}`,
    fix: `npm install ${missing.map((peer) => `${peer.name}@${peer.range}`).join(" ")}`,
  };
}
