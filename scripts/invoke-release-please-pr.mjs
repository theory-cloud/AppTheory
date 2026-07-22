#!/usr/bin/env node
// Purpose: invoke release-please with its credential held in memory, never in npm or OS process arguments.

import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

class SafeInvocationError extends Error {}

function fail(message) {
  console.error(`release-please-pr: FAIL (${message})`);
  process.exitCode = 1;
}

function requiredEnvironment(name) {
  const value = process.env[name] ?? "";
  if (value.length === 0) {
    throw new SafeInvocationError(`missing ${name}`);
  }
  if (value.includes("\n") || value.includes("\r")) {
    throw new SafeInvocationError(`invalid ${name}`);
  }
  return value;
}

function buildReleasePleaseArgs() {
  const releasePleaseArgs = [
    "release-pr",
    "--token",
    requiredEnvironment("RELEASE_PLEASE_TOKEN"),
    "--repo-url",
    requiredEnvironment("RELEASE_PLEASE_REPO_URL"),
    "--target-branch",
    requiredEnvironment("RELEASE_PLEASE_TARGET_BRANCH"),
    "--config-file",
    requiredEnvironment("RELEASE_PLEASE_CONFIG_FILE"),
    "--manifest-file",
    requiredEnvironment("RELEASE_PLEASE_MANIFEST_FILE"),
    "--draft-pull-request",
  ];

  const releaseAs = process.env.RELEASE_PLEASE_RELEASE_AS ?? "";
  if (releaseAs.includes("\n") || releaseAs.includes("\r")) {
    throw new SafeInvocationError("invalid RELEASE_PLEASE_RELEASE_AS");
  }
  if (releaseAs.length > 0) {
    releasePleaseArgs.push("--release-as", releaseAs);
  }

  return releasePleaseArgs;
}

function installAutomatedCommitPolicy(packageRoot) {
  const codeSuggesterModule = require.resolve("code-suggester", { paths: [packageRoot] });
  const codeSuggester = require(codeSuggesterModule);
  if (typeof codeSuggester.createPullRequest !== "function") {
    throw new SafeInvocationError("pinned release-please commit transport is unavailable");
  }

  const createPullRequest = codeSuggester.createPullRequest;
  codeSuggester.createPullRequest = async (octokit, changes, options) => {
    if (typeof options?.message !== "string" || options.message.length === 0) {
      throw new SafeInvocationError("pinned release-please commit message is unavailable");
    }

    const message = options.message.includes("[skip ci]") ? options.message : `${options.message}\n\n[skip ci]`;
    return createPullRequest(octokit, changes, { ...options, message });
  };
}

const launcherArgs = process.argv.slice(2);
if (launcherArgs.length !== 0) {
  fail("environment-only launcher does not accept arguments");
} else {
  try {
    const releasePleaseArgs = buildReleasePleaseArgs();

    const releasePleasePackageRoot = requiredEnvironment("RELEASE_PLEASE_PACKAGE_ROOT");
    const releasePleaseModule = requiredEnvironment("RELEASE_PLEASE_CLI_MODULE");
    if (!fs.existsSync(releasePleasePackageRoot)) {
      throw new SafeInvocationError("pinned release-please package is unavailable");
    }
    if (!fs.existsSync(releasePleaseModule)) {
      throw new SafeInvocationError("pinned release-please module is unavailable");
    }

    installAutomatedCommitPolicy(releasePleasePackageRoot);
    const { parser } = require(releasePleaseModule);
    if (typeof parser?.parseAsync !== "function") {
      throw new SafeInvocationError("pinned release-please parser is unavailable");
    }

    await parser.parseAsync(releasePleaseArgs);
  } catch (error) {
    const message = error instanceof SafeInvocationError ? error.message : "release-please invocation failed";
    fail(message);
  }
}
