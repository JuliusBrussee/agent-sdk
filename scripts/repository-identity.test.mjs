import assert from "node:assert/strict";
import test from "node:test";

import {
  EXPECTED_REPOSITORY,
  assertRepositoryRemote,
  repositoryFromRemoteUrl,
} from "./check-repository-identity.mjs";

test("canonical HTTPS and SSH GitHub remotes resolve to repository identity", () => {
  for (const remote of [
    "https://github.com/JuliusBrussee/agent-sdk.git",
    "https://github.com/JuliusBrussee/agent-sdk",
    "git@github.com:JuliusBrussee/agent-sdk.git",
    "ssh://git@github.com/JuliusBrussee/agent-sdk.git",
  ]) {
    assert.equal(repositoryFromRemoteUrl(remote), EXPECTED_REPOSITORY);
    assert.doesNotThrow(() => assertRepositoryRemote(remote));
  }
});

test("old typo repository and every other destination fail closed", () => {
  for (const remote of [
    "https://github.com/JuliusBrussee/agent-sdk-ollldd.git",
    "git@github.com:JuliusBrussee/caveman-agent-sdk.git",
    "https://gitlab.com/JuliusBrussee/agent-sdk.git",
    "file:///tmp/agent-sdk.git",
    "not-a-remote",
  ]) {
    assert.throws(
      () => assertRepositoryRemote(remote, "test destination"),
      /repository_identity_mismatch/,
    );
  }
});

test("credential-bearing URLs never leak credentials in failure text", () => {
  const secret = "github_pat_secret_value";
  for (const remote of [
    `https://oauth2:${secret}@github.com/JuliusBrussee/wrong-repo.git`,
    `https://oauth2:${secret}@github.com/JuliusBrussee/agent-sdk.git`,
  ]) {
    assert.throws(
      () => assertRepositoryRemote(remote),
      (error) => {
        assert.doesNotMatch(error.message, new RegExp(secret));
        assert.match(error.message, /unrecognized remote URL/);
        return true;
      },
    );
  }
});

test("custom ports and URL modifiers fail closed", () => {
  for (const remote of [
    "https://github.com:444/JuliusBrussee/agent-sdk.git",
    "https://github.com/JuliusBrussee/agent-sdk.git?mirror=1",
    "https://github.com/JuliusBrussee/agent-sdk.git#other",
  ]) {
    assert.throws(() => assertRepositoryRemote(remote), /repository_identity_mismatch/);
  }
});
