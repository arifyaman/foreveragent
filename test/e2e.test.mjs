// End-to-end tests: real orchestrator + git, fake pi.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { writeFile } from "node:fs/promises";
import {
  makeRepo,
  runForeverAgent,
  commits,
  readRepoFile,
  eventTypes,
} from "./helpers.mjs";

const OK_TEXT = (n) =>
  JSON.stringify({
    success: true,
    summary: `did work ${n}`,
    key_changes_made: [`change ${n}`],
    key_learnings: [`learning ${n}`],
    should_stop: false,
  });

const FILES = { "work.txt": "content {iteration}\n" };

test("commits each successful iteration and stops at max-iterations", async () => {
  const repo = await makeRepo();
  const result = await runForeverAgent(
    repo,
    ["objective: iterate", "--pi-bin", "test/fake-pi.mjs", "--models", "a/m1", "--max-iterations", "3"],
    {
      scenario: { models: { "a/m1": { default: { exit: 0, text: '{"success": true, "summary": "did work", "key_changes_made": ["x"], "key_learnings": [], "should_stop": false}', files: { "work.txt": "content {iteration}\n" } } } } },
    },
  );
  assert.equal(result.code, 0, `exit code, stderr: ${result.stderr}`);
  assert.equal(await commits(repo), 3, "three iteration commits");
  assert.equal(result.state.reason, "max_iterations");
  assert.equal(result.state.commits, 3);
  assert.match(result.notes, /Iteration 1/, "notes record iteration 1");
  assert.match(result.notes, /Iteration 3/, "notes record iteration 3");
  assert.ok((await readRepoFile(repo, "work.txt")) !== null, "work file kept");
  const types = eventTypes(result.events);
  assert.ok(types.includes("run_start") && types.includes("run_end"));
  assert.equal(types.filter((t) => t === "iteration_success").length, 3);
});

test("adds .foreveragent to git info/exclude and keeps tree clean of run data", async () => {
  const repo = await makeRepo();
  const result = await runForeverAgent(
    repo,
    ["objective: iterate", "--pi-bin", "test/fake-pi.mjs", "--models", "a/m1", "--max-iterations", "1"],
    { scenario: { models: { "a/m1": { default: { exit: 0, text: OK_TEXT(1), files: FILES } } } } },
  );
  assert.equal(result.code, 0, result.stderr);
  const exclude = await readRepoFile(repo, ".git/info/exclude");
  assert.match(exclude, /foreveragent/);
  // Only the iteration commit should touch tracked files.
  assert.equal(await commits(repo), 1);
});

test("fails over to the next model on a 429 rate-limit error", async () => {
  const repo = await makeRepo();
  const scenario = {
    models: {
      "a/m1": {
        iterations: [
          { iteration: 1, exit: 1, stderr: "Error: HTTP 429 - rate limit exceeded, please retry in 1 seconds" },
        ],
        default: { exit: 1, stderr: "Error: HTTP 429 - rate limit exceeded" },
      },
      "b/m2": { default: { exit: 0, text: OK_TEXT(1), files: FILES } },
    },
  };
  const result = await runForeverAgent(
    repo,
    ["objective: failover", "--pi-bin", "test/fake-pi.mjs", "--models", "a/m1", "b/m2", "--max-iterations", "2"],
    { scenario, timeoutMs: 120_000 },
  );
  assert.equal(result.code, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
  assert.equal(await commits(repo), 2, "both iterations committed via fallback model");
  const errors = result.events.filter((e) => e.type === "agent_error");
  assert.equal(errors.length, 1, "one model error recorded");
  assert.equal(errors[0].model, "a/m1");
  assert.equal(errors[0].kind, "rate_limit");
  const success = result.events.find((e) => e.type === "iteration_success" && e.iteration === 1);
  assert.equal(success.model, "b/m2", "iteration 1 completed on the fallback model");
  // Sticky: iteration 2 also runs on b/m2.
  assert.equal(result.state.currentModel, "b/m2");
});

test("rolls back the working tree when the agent reports failure", async () => {
  const repo = await makeRepo();
  const scenario = {
    models: {
      "a/m1": {
        iterations: [
          { iteration: 1, exit: 0, text: '{"success": false, "summary": "attempt failed", "key_changes_made": [], "key_learnings": ["try otherwise"], "should_stop": false}', files: { "junk.txt": "should be rolled back" } },
          { iteration: 2, exit: 0, text: OK_TEXT(2), files: { "good.txt": "kept" } },
        ],
      },
    },
  };
  const result = await runForeverAgent(
    repo,
    ["objective: rollback", "--pi-bin", "test/fake-pi.mjs", "--models", "a/m1", "--max-iterations", "2"],
    { scenario },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await readRepoFile(repo, "junk.txt"), null, "failed work rolled back");
  assert.equal(await readRepoFile(repo, "good.txt"), "kept");
  assert.equal(await commits(repo), 1);
  assert.equal(result.state.failures, 1);
  const failed = result.events.find((e) => e.type === "iteration_failed");
  assert.equal(failed.iteration, 1);
});

test("stops with reason done when the agent sets should_stop", async () => {
  const repo = await makeRepo();
  const scenario = {
    models: {
      "a/m1": {
        default: {
          exit: 0,
          text: '{"success": true, "summary": "objective met", "key_changes_made": ["finished"], "key_learnings": [], "should_stop": true}',
          files: { "final.txt": "done" },
        },
      },
    },
  };
  const result = await runForeverAgent(
    repo,
    ["objective: stop", "--pi-bin", "test/fake-pi.mjs", "--models", "a/m1", "--max-iterations", "10"],
    { scenario },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.state.reason, "done");
  assert.equal(await commits(repo), 1);
  assert.equal(result.state.iteration, 1, "no further iterations");
});

test("aborts when every model is dead (model not found)", async () => {
  const repo = await makeRepo();
  const scenario = {
    models: {
      "a/m1": { default: { exit: 1, stderr: 'Error: Model "a/m1" not found. Use --list-models.' } },
      "b/m2": { default: { exit: 1, stderr: "Error: 404 model does not exist" } },
    },
  };
  const result = await runForeverAgent(
    repo,
    ["objective: dead", "--pi-bin", "test/fake-pi.mjs", "--models", "a/m1", "b/m2", "--max-iterations", "5"],
    { scenario },
  );
  assert.equal(result.code, 2, result.stderr);
  assert.equal(result.state.reason, "all_models_dead");
  assert.equal(await commits(repo), 0);
  const dead = result.events.filter((e) => e.type === "model_dead");
  assert.equal(dead.length, 2);
});

test("aborts after repeated unexplained agent errors across all models", async () => {
  const repo = await makeRepo();
  const scenario = {
    models: {
      "a/m1": { default: { exit: 1, stderr: "some totally unexplained crash" } },
      "b/m2": { default: { exit: 1, stderr: "another unexplained crash" } },
    },
  };
  // Short cooldown so the exhaustion loop runs fast.
  const configPath = path.join(tmpdir(), `fa-config-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  await writeFile(configPath, JSON.stringify({ failover: { cooldownMs: 50, backoffBaseMs: 50, backoffMaxMs: 500 } }));
  const result = await runForeverAgent(
    repo,
    [
      "objective: exhaust",
      "--pi-bin",
      "test/fake-pi.mjs",
      "--models",
      "a/m1",
      "b/m2",
      "--max-iterations",
      "50",
      "--config",
      configPath,
    ],
    { scenario, timeoutMs: 120_000 },
  );
  assert.equal(result.code, 2, result.stderr);
  assert.equal(result.state.reason, "agent_errors_exhausted");
});

test("stops as stalled after consecutive no-op iterations", async () => {
  const repo = await makeRepo();
  const scenario = {
    models: { "a/m1": { default: { exit: 0, text: '{"success": true, "summary": "nothing to do", "key_changes_made": [], "key_learnings": [], "should_stop": false}' } } },
  };
  const result = await runForeverAgent(
    repo,
    ["objective: stall", "--pi-bin", "test/fake-pi.mjs", "--models", "a/m1", "--max-iterations", "10", "--max-no-ops", "2"],
    { scenario },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.state.reason, "stalled");
  assert.equal(await commits(repo), 0);
  assert.equal(result.state.noOps, 2);
});

test("fails over when the agent output has no valid JSON (format error)", async () => {
  const repo = await makeRepo();
  const scenario = {
    models: {
      "a/m1": { default: { exit: 0, text: "I am sorry, I got confused and cannot finish this properly." } },
      "b/m2": { default: { exit: 0, text: OK_TEXT(1), files: FILES } },
    },
  };
  const result = await runForeverAgent(
    repo,
    ["objective: format", "--pi-bin", "test/fake-pi.mjs", "--models", "a/m1", "b/m2", "--max-iterations", "2"],
    { scenario, timeoutMs: 120_000 },
  );
  assert.equal(result.code, 0, `stderr: ${result.stderr}`);
  const errors = result.events.filter((e) => e.type === "agent_error" && e.model === "a/m1");
  assert.ok(errors.length >= 1, "format error recorded");
  assert.equal(errors[0].kind, "format");
  assert.equal(await commits(repo), 2);
});

test("treats an agent timeout as a model error and fails over", async () => {
  const repo = await makeRepo();
  const scenario = {
    models: {
      "a/m1": { iterations: [{ iteration: 1, exit: 0, text: OK_TEXT(1), delayMs: 1500 }] },
      "b/m2": { default: { exit: 0, text: OK_TEXT(1), files: FILES } },
    },
  };
  const result = await runForeverAgent(
    repo,
    ["objective: timeout", "--pi-bin", "test/fake-pi.mjs", "--models", "a/m1", "b/m2", "--max-iterations", "1", "--agent-timeout", "500ms"],
    { scenario, timeoutMs: 120_000 },
  );
  assert.equal(result.code, 0, result.stderr);
  const errors = result.events.filter((e) => e.type === "agent_error");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].kind, "timeout");
  const success = result.events.find((e) => e.type === "iteration_success");
  assert.equal(success.model, "b/m2");
  assert.equal(await commits(repo), 1);
});

test("rejects a dirty working tree unless --allow-dirty is given", async () => {
  const repo = await makeRepo();
  await writeFile(path.join(repo, "dirty.txt"), "x");
  const result = await runForeverAgent(
    repo,
    ["objective: dirty", "--pi-bin", "test/fake-pi.mjs", "--models", "a/m1", "--max-iterations", "1"],
    { scenario: { models: { "a/m1": { default: { exit: 0, text: OK_TEXT(1), files: FILES } } } } },
  );
  assert.equal(result.code, 1);
  assert.match(result.stderr, /not clean/);

  const allowed = await runForeverAgent(
    repo,
    ["objective: dirty", "--pi-bin", "test/fake-pi.mjs", "--models", "a/m1", "--max-iterations", "1", "--allow-dirty"],
    { scenario: { models: { "a/m1": { default: { exit: 0, text: OK_TEXT(1), files: FILES } } } } },
  );
  assert.equal(allowed.code, 0, allowed.stderr);
});

test("creates and uses a new branch with --branch", async () => {
  const repo = await makeRepo();
  const result = await runForeverAgent(
    repo,
    ["objective: branch", "--pi-bin", "test/fake-pi.mjs", "--models", "a/m1", "--max-iterations", "1", "--branch", "fa-test"],
    { scenario: { models: { "a/m1": { default: { exit: 0, text: OK_TEXT(1), files: FILES } } } } },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.state.branch, "fa-test");
  assert.equal(await commits(repo), 1);
});

test("parses JSON results wrapped in markdown fences and prose", async () => {
  const repo = await makeRepo();
  const scenario = {
    models: {
      "a/m1": {
        default: {
          exit: 0,
          text: "Sure! Here is the result:\n\n```json\n" + OK_TEXT(1) + "\n```\n\nDone!",
          files: FILES,
        },
      },
    },
  };
  const result = await runForeverAgent(
    repo,
    ["objective: fences", "--pi-bin", "test/fake-pi.mjs", "--models", "a/m1", "--max-iterations", "1"],
    { scenario },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.state.commits, 1);
});

test("dry-run prints the prompt and exits without running", async () => {
  const repo = await makeRepo();
  const result = await runForeverAgent(repo, [
    "objective: dry",
    "--pi-bin",
    "test/fake-pi.mjs",
    "--models",
    "a/m1",
    "--dry-run",
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /This is iteration 1/);
  assert.equal(await commits(repo), 0);
});

test("--stop-when is recorded in state and prompt", async () => {
  const repo = await makeRepo();
  const result = await runForeverAgent(
    repo,
    [
      "objective: stopwhen",
      "--pi-bin",
      "test/fake-pi.mjs",
      "--models",
      "a/m1",
      "--max-iterations",
      "1",
      "--stop-when",
      "all tests pass",
    ],
    { scenario: { models: { "a/m1": { default: { exit: 0, text: OK_TEXT(1), files: FILES } } } } },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.state.stopWhen, "all tests pass");
});
