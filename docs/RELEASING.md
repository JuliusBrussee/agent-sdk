# Releasing

## Versioning policy

Every package follows [semver](https://semver.org). Packages version
independently — a change to one adapter does not bump the others.

### What is public API

For `@caveman-ai/agent`, the public API is exactly the contents of
[`packages/agent/api-surface.txt`](../packages/agent/api-surface.txt): every
name reachable from a subpath declared in `exports`. `npm run check:api` fails
when that set changes, so the golden diff is the review surface.

For every other package, the public API is what its `exports` map reaches.

Anything under `src/` that no `exports` subpath reaches is internal and may
change in a patch release. That includes files a consumer could reach by deep
importing `dist/…` — deep imports are not supported.

### What is breaking

Major (or, pre-1.0, minor):

- Removing or renaming an entry in `api-surface.txt`.
- Narrowing a parameter type or widening a return type on a public function.
- Removing an `exports` subpath, a `bin`, or a CLI subcommand or flag.
- Changing the shape, ordering, or framing of `@pebble-agent/protocol` events,
  or of a persisted receipt, journal, or lock file, without a version bump in
  the artifact itself.
- Raising the `engines.node` floor.
- Changing a fail-closed path to fail open, or an inferred number to a claimed
  one. These are contracts, not implementation details — see `AGENTS.md`.

Minor: new exports, new optional options, new CLI flags, new adapters.

Patch: fixes that leave `api-surface.txt` and the artifact formats untouched.

### Upstream pins

Adapters pin their framework exactly. A pin bump is a **minor** release of that
adapter, never a patch: the framework's own semver is not this package's semver,
and a consumer needs the pin change to be visible. Every adapter is still 0.x,
where the "major" column above also lands on minor — so pre-1.0 the practical
rule is that a pin bump is never a patch.

When an adapter carries the upstream in both `peerDependencies` and
`devDependencies`, the two must move together; the adapter registry test fails
otherwise. Dependabot only sees the devDependency.

`npm run check:drift` lists pins that have moved (network, weekly in CI, never
fails the build); Dependabot opens the PRs.

## Cutting a release

1. Move the relevant `## [Unreleased]` entries in `CHANGELOG.md` under a new
   heading for the release.
2. Bump the version of each package you are releasing:
   `npm version <patch|minor|major> --workspace <name> --no-git-tag-version`.
   If you bumped `@caveman-ai/agent`, update the exact `@caveman-ai/agent` pin
   in every adapter's `peerDependencies` in the same commit.
3. Run the canonical check block from `AGENTS.md` — `npm ci`, the
   `pebble-protocol` build, the `examples/coding-agent` install, then
   `npm test && npm run license:check && npm run pack:check`.
4. Commit, then tag and push: `git push --follow-tags`. The tag is convention
   only — the workflow publishes purely by "this version is not on the
   registry" and never reads the tag name. Use `v<agent-version>` when
   `@caveman-ai/agent` moved; when it did not, use a dated tag
   (`release-2026-08-30`) rather than inventing a fake agent version.
5. The `release` workflow publishes every workspace whose version is not
   already on the registry, with npm provenance. Packages you did not bump are
   skipped, so a tag is safe to push even when only one package changed.

The workflow needs an `NPM_TOKEN` secret with publish rights on the
`@caveman-ai` and `@pebble-agent` scopes, exposed through a `release`
environment so publishing requires whatever approval that environment enforces.
