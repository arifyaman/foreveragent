// Unit tests: git helpers and duration parsing.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  isGitRepo,
  hasHead,
  isClean,
  status,
  ensureExcluded,
  stageAll,
  commit,
  rollback,
  headShort,
  checkoutNewBranch,
} from "../src/git.mjs";
import { gitExec, makeRepo } from "./helpers.mjs";
import { parseDuration, formatDuration } from "../src/log.mjs";

async function freshRepo() {
  const dir = await mkdtemp(path.join(tmpdir(), "fa-git-"));
  await gitExec(dir, ["init", "-b", "main"]);
  await gitExec(dir, ["config", "user.name", "T"]);
  await gitExec(dir, ["config", "user.email", "t@example.com"]);
  return dir;
}

test("isGitRepo / hasHead basics", async () => {
  const dir = await freshRepo();
  assert.equal(await isGitRepo(dir), true);
  assert.equal(await hasHead(dir), false);
  assert.equal(await isGitRepo(tmpdir()), false);
  await writeFile(path.join(dir, "a.txt"), "a");
  await gitExec(dir, ["add", "-A"]);
  await gitExec(dir, ["commit", "-m", "init"]);
  assert.equal(await hasHead(dir), true);
  assert.equal(await headShort(dir).then((h) => h.length > 0), true);
});

test("clean tree detection", async () => {
  const repo = await makeRepo();
  assert.equal(await isClean(repo), true);
  await writeFile(path.join(repo, "new.txt"), "x");
  assert.equal(await isClean(repo), false);
  const lines = await status(repo);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /new\.txt/);
});

test("commit stages and records a commit", async () => {
  const repo = await makeRepo();
  await writeFile(path.join(repo, "b.txt"), "b");
  await stageAll(repo);
  const result = await commit(repo, "test commit");
  assert.equal(result.ok, true, result.error);
  assert.equal(await isClean(repo), true);
  const log = await gitExec(repo, ["log", "--oneline", "-1"]);
  assert.match(log, /test commit/);
});

test("commit fails gracefully on empty tree", async () => {
  const repo = await makeRepo();
  const result = await commit(repo, "empty");
  assert.equal(result.ok, false);
});

test("rollback discards tracked changes and untracked files", async () => {
  const repo = await makeRepo();
  const { mkdir } = await import("node:fs/promises");
  await writeFile(path.join(repo, "README.md"), "changed\n");
  await writeFile(path.join(repo, "untracked.txt"), "new");
  await mkdir(path.join(repo, "untracked-dir"), { recursive: true });
  await writeFile(path.join(repo, "untracked-dir/x.txt"), "nested");
  await rollback(repo);
  assert.equal(await isClean(repo), true);
  const { readFile } = await import("node:fs/promises");
  const { readRepoFile } = await import("./helpers.mjs");
  assert.equal(await readRepoFile(repo, "untracked.txt"), null);
  const readme = await readFile(path.join(repo, "README.md"), "utf8");
  assert.equal(readme, "# test repo\n");
});

test("ensureExcluded writes to .git/info/exclude and is idempotent", async () => {
  const repo = await makeRepo();
  await ensureExcluded(repo, ".foreveragent");
  await ensureExcluded(repo, ".foreveragent");
  const { readRepoFile } = await import("./helpers.mjs");
  const exclude = await readRepoFile(repo, ".git/info/exclude");
  const matches = exclude.split("\n").filter((line) => line.trim() === ".foreveragent");
  assert.equal(matches.length, 1);
  // And excluded dirs do not dirty the tree.
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.join(repo, ".foreveragent"), { recursive: true });
  assert.equal(await isClean(repo), true);
});

test("checkoutNewBranch creates and switches", async () => {
  const repo = await makeRepo();
  const result = await checkoutNewBranch(repo, "fa-test");
  assert.equal(result.ok, true, result.error);
  const branch = await gitExec(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  assert.equal(branch, "fa-test");
  const again = await checkoutNewBranch(repo, "fa-test");
  assert.equal(again.ok, false);
});

test("parseDuration", () => {
  assert.equal(parseDuration("30"), 30_000);
  assert.equal(parseDuration("30s"), 30_000);
  assert.equal(parseDuration("45m"), 2_700_000);
  assert.equal(parseDuration("8h"), 28_800_000);
  assert.equal(parseDuration("500ms"), 500);
  assert.throws(() => parseDuration("banana"));
});

test("formatDuration", () => {
  assert.equal(formatDuration(5_000), "5s");
  assert.equal(formatDuration(125_000), "2m 5s");
  assert.equal(formatDuration(3_725_000), "1h 2m 5s");
});
