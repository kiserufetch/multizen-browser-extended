#!/usr/bin/env node
// Hard-gate for publish-release: origin and gh must target the fork only.
// Upstream (multizenteam/multizen-browser) must never receive release PRs.
//
// Usage:
//   node scripts/assert-release-repo.mjs
//   node scripts/assert-release-repo.mjs --pr-url <url>   # post-create check
//
// Exit 0 only when safe. Exit 1 with a clear message otherwise.

import { execFileSync } from "node:child_process";

const FORK = "kiserufetch/multizen-browser-extended";
const UPSTREAM = "multizenteam/multizen-browser";

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8" }).trim();
}

function normalizeGithubRepo(urlOrSlug) {
  if (!urlOrSlug) return "";
  let s = urlOrSlug.trim();
  s = s.replace(/^git@github\.com:/i, "");
  s = s.replace(/^https?:\/\/github\.com\//i, "");
  s = s.replace(/\.git$/i, "");
  s = s.replace(/\/$/g, "");
  return s.toLowerCase();
}

function fail(msg) {
  console.error(`assert-release-repo: ${msg}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const prUrlIdx = args.indexOf("--pr-url");
if (prUrlIdx !== -1) {
  const prUrl = args[prUrlIdx + 1];
  if (!prUrl) fail("--pr-url requires a URL argument.");
  const normalized = normalizeGithubRepo(prUrl.replace(/\/pull\/\d+.*$/i, ""));
  // pr URLs look like github.com/owner/repo/pull/N — strip /pull/...
  const match = prUrl.match(/github\.com\/([^/]+\/[^/]+)/i);
  const repo = match ? match[1].toLowerCase() : normalized;
  if (repo === UPSTREAM.toLowerCase()) {
    fail(
      `PR targets upstream ${UPSTREAM}. Close it immediately and recreate on ${FORK}. ` +
        `Refusing to continue the release.`
    );
  }
  if (repo !== FORK.toLowerCase()) {
    fail(`PR URL is not on ${FORK} (got "${repo || prUrl}"). Aborting.`);
  }
  console.log(`assert-release-repo: PR URL OK (${FORK})`);
  process.exit(0);
}

let originUrl;
try {
  originUrl = run("git", ["remote", "get-url", "origin"]);
} catch {
  fail("Could not read `origin` remote. Aborting.");
}

const originRepo = normalizeGithubRepo(originUrl);
if (originRepo === UPSTREAM.toLowerCase()) {
  fail(
    `origin points at upstream ${UPSTREAM}. ` +
      `Release PRs must use origin → ${FORK}. Fix remotes and retry.`
  );
}
if (originRepo !== FORK.toLowerCase()) {
  fail(`origin must be ${FORK} (got "${originRepo || originUrl}"). Aborting.`);
}

// Pin gh default so bare `gh pr create` cannot drift to upstream.
try {
  run("gh", ["repo", "set-default", FORK]);
} catch (err) {
  fail(`Failed to set gh default repo to ${FORK}: ${err.message || err}`);
}

let ghDefault;
try {
  ghDefault = run("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]);
} catch (err) {
  fail(`Could not verify gh default repo: ${err.message || err}`);
}

if (normalizeGithubRepo(ghDefault) !== FORK.toLowerCase()) {
  fail(`gh default repo is "${ghDefault}", expected ${FORK}. Aborting.`);
}

console.log(`assert-release-repo: OK (origin + gh → ${FORK})`);
