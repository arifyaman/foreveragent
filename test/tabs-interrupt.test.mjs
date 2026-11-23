// E2E tests for the graceful interrupt handling in tabs mode.
// Each case runs the fallback path (workspaceId: null) in a child process
// with a synthetic slow fake pi, sends SIGINT(s), and asserts on the
// resulting state.json / notes.md / git tree / stray processes.

import { test } from "node:test";
import assert from "node:assert";
import { spawn, execSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const DRIVER = join(ROOT, "test", "tabs-interrupt-driver.mjs");
const FAKE = join(ROOT, "test", "interrupt-fake-pi.mjs");

const FINAL_PREFIX = "FINAL_STATE ";

async function setupRepo() {
  const repo = mkdtempSync(join(tmpdir(), "fa-tabs-interrupt-"));
  execSync("git init -q .", { cwd: repo, stdio: "ignore" });
  execSync("git config user.name T && git config user.email t@t", { cwd: repo, stdio: "ignore" });
  execSync("git commit -q --allow-empty -m init", { cwd: repo, stdio: "ignore" });
  return repo;
}

function gitStatus(repo) {
  return execSync("git status --porcelain", { cwd: repo, encoding: "utf8" }).trim();
}

function gitCommitCount(repo) {
  return Number(execSync("git rev-list --count HEAD", { cwd: repo, encoding: "utf8" }).trim());
}

function readRunDir(repo) {
  const runsRoot = join(repo, ".foreveragent", "runs");
  const entries = readdirSync(runsRoot);
  assert.strictEqual(entries.length, 1, `expected exactly one run dir, found ${entries.length}`);
  return join(runsRoot, entries[0]);
}

function readNotes(runDir) {
  return readFileSync(join(runDir, "notes.md"), "utf8");
}

function readState(runDir) {
  return JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
}

function parseFinal(stdout) {
  const line = stdout.split("\n").find((l) => l.startsWith(FINAL_PREFIX));
  assert.ok(line, `FINAL_STATE line not found; output:\n${stdout}`);
  return JSON.parse(line.slice(FINAL_PREFIX.length));
}

function strayFakePiPids() {
  try {
    // The [.] trick avoids matching this very pgrep subprocess.
    const out = execSync("pgrep -f 'interrupt-fake-pi[.]mjs' || true", { encoding: "utf8" });
    return out.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function waitForNoStrays(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (strayFakePiPids().length === 0) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.deepStrictEqual(strayFakePiPids(), [], "fake pi process is still running");
}

/**
 * Run the driver in a subprocess, send SIGINT(s) at the given delays, and
 * wait for it to exit. Returns { repo, stdout, stderr, elapsedMs, exit }.
 */
async function runScenario({ delayMs, graceMs, signals = [], maxIterations = 0 }) {
  const repo = await setupRepo();
  const started = Date.now();
  const child = spawn(process.execPath, [DRIVER, repo, FAKE], {
    env: {
      ...process.env,
      FA_TEST_DELAY_MS: String(delayMs),
      FA_DRAIN_GRACE_MS: String(graceMs),
      FA_TEST_MAX_ITERATIONS: String(maxIterations),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "", stderr = "";
  child.stdout.on("data", (c) => { stdout += c; });
  child.stderr.on("data", (c) => { stderr += c; });

  const timers = signals.map((s) =>
    setTimeout(() => { try { child.kill("SIGINT"); } catch {} }, s.afterMs),
  );

  const exit = await new Promise((resolve) => {
    child.on("close", (code, sig) => resolve({ code, signal: sig, timeout: false }));
    setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      resolve({ code: null, signal: null, timeout: true });
    }, 90000);
  });
  for (const t of timers) clearTimeout(t);

  return { repo, stdout, stderr, elapsedMs: Date.now() - started, exit };
}

test("completes cleanly when no signal is sent", { timeout: 120000 }, async (t) => {
  const { repo, stdout, exit } = await runScenario({ delayMs: 0, graceMs: 10000, maxIterations: 1 });
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  assert.ok(!exit.timeout, `driver timed out; output:\n${stdout}`);
  const final = parseFinal(stdout);
  assert.strictEqual(final.status, "complete");
  assert.strictEqual(final.reason, "max_iterations");
  assert.strictEqual(final.commits, 1);
  assert.strictEqual(final.iteration, 1);

  const runDir = readRunDir(repo);
  assert.match(readNotes(runDir), /success/);
  assert.ok(gitCommitCount(repo) >= 2, "expected the iteration to be committed");
  assert.strictEqual(gitStatus(repo), "");
});

test("SIGINT drains the in-flight iteration: it finishes, commits, then stops", { timeout: 120000 }, async (t) => {
  const { repo, stdout, exit } = await runScenario({ delayMs: 2500, graceMs: 10000, signals: [{ afterMs: 1000 }] });
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  assert.ok(!exit.timeout, `driver timed out; output:\n${stdout}`);
  const final = parseFinal(stdout);
  assert.strictEqual(final.status, "interrupted");
  assert.strictEqual(final.reason, "interrupted");
  assert.strictEqual(final.commits, 1, "drained iteration should be committed");
  assert.strictEqual(final.iteration, 1);

  const runDir = readRunDir(repo);
  assert.match(readNotes(runDir), /success/);
  assert.ok(gitCommitCount(repo) >= 2, "drained iteration should be committed");
  assert.strictEqual(gitStatus(repo), "");
});

test("SIGINT with grace expiry kills the in-flight iteration and rolls back", { timeout: 120000 }, async (t) => {
  const { repo, stdout, elapsedMs, exit } = await runScenario({ delayMs: 20000, graceMs: 2500, signals: [{ afterMs: 1000 }] });
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  assert.ok(!exit.timeout, `driver timed out; output:\n${stdout}`);
  assert.ok(elapsedMs < 15000, `expected kill well before the fake's 20s delay (${elapsedMs}ms)`);
  const final = parseFinal(stdout);
  assert.strictEqual(final.status, "interrupted");
  assert.strictEqual(final.reason, "interrupted");
  assert.strictEqual(final.commits, 0);
  assert.strictEqual(final.iteration, 1);

  const runDir = readRunDir(repo);
  assert.match(readNotes(runDir), /interrupted/);
  assert.strictEqual(gitStatus(repo), "", "tree must be rolled back after the kill");
  await waitForNoStrays();
});

test("second SIGINT aborts the in-flight iteration immediately", { timeout: 120000 }, async (t) => {
  const { repo, stdout, elapsedMs, exit } = await runScenario({
    delayMs: 30000,
    graceMs: 8000,
    signals: [{ afterMs: 1000 }, { afterMs: 1500 }],
  });
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  assert.ok(!exit.timeout, `driver timed out; output:\n${stdout}`);
  assert.ok(elapsedMs < 6000, `expected immediate abort well inside the 8s grace (${elapsedMs}ms)`);
  const final = parseFinal(stdout);
  assert.strictEqual(final.status, "interrupted");
  assert.strictEqual(final.reason, "interrupted");
  assert.strictEqual(final.commits, 0);

  const runDir = readRunDir(repo);
  assert.match(readNotes(runDir), /interrupted/);
  assert.strictEqual(gitStatus(repo), "");
  await waitForNoStrays();
});
