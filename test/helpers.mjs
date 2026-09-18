// Shared helpers for tests.

import { execFile } from "node:child_process";
import { mkdtemp, writeFile, mkdir, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BIN = path.join(ROOT, "bin", "foreveragent.mjs");

export function gitExec(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, encoding: "utf8", timeout: 30_000 }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(new Error((stderr || error.message).trim()), { stdout, stderr }));
      else resolve((stdout || "").trim());
    });
  });
}

/** Create a temp git repo with one initial commit. */
export async function makeRepo() {
  const dir = await mkdtemp(path.join(tmpdir(), "fa-e2e-"));
  await gitExec(dir, ["init", "-b", "main"]);
  await gitExec(dir, ["config", "user.name", "Test User"]);
  await gitExec(dir, ["config", "user.email", "test@example.com"]);
  await writeFile(path.join(dir, "README.md"), "# test repo\n");
  await gitExec(dir, ["add", "-A"]);
  await gitExec(dir, ["commit", "-m", "initial"]);
  return dir;
}

// Scenario files live in the OS temp dir (never inside the repo, so the
// clean-tree check stays valid).
let scenarioSeq = 0;
export async function writeScenario(scenario) {
  scenarioSeq += 1;
  const file = path.join(tmpdir(), `fa-scenario-${process.pid}-${Date.now()}-${scenarioSeq}.json`);
  await writeFile(file, JSON.stringify(scenario, null, 2));
  return file;
}

/**
 * Run the foreveragent CLI against a repo with a scenario file.
 * Returns { code, stdout, stderr, runDir, events, state, notes }.
 */
export async function runForeverAgent(repo, argv, { scenario = null, timeoutMs = 90_000 } = {}) {
  const env = { ...process.env };
  if (scenario) {
    env.FA_SCENARIO = await writeScenario(scenario);
  }
  // Resolve the fake pi to an absolute path: the CLI runs with cwd=repo.
  const fixedArgv = argv.map((arg, i) =>
    argv[i - 1] === "--pi-bin" && !path.isAbsolute(arg) ? path.join(ROOT, arg) : arg,
  );
  const { code, stdout, stderr, timedOut } = await new Promise((resolve) => {
    execFile(
      process.execPath,
      [BIN, ...fixedArgv],
      { cwd: repo, env, encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (error, out, err) => {
        resolve({
          code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          stdout: out || "",
          stderr: err || "",
          timedOut: Boolean(error?.killed),
        });
      },
    );
  });

  const runsDir = path.join(repo, ".foreveragent", "runs");
  let runDir = null;
  let events = [];
  let state = null;
  let notes = "";
  try {
    const runs = await readdir(runsDir);
    if (runs.length > 0) {
      runDir = path.join(runsDir, runs[runs.length - 1]);
      const rawLog = await readFile(path.join(runDir, "run.log"), "utf8").catch(() => "");
      events = rawLog
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      state = JSON.parse((await readFile(path.join(runDir, "state.json"), "utf8").catch(() => "{}")) || "{}");
      notes = await readFile(path.join(runDir, "notes.md"), "utf8").catch(() => "");
    }
  } catch {
    /* no run dir */
  }
  return { code, stdout, stderr, timedOut, runDir, events, state, notes };
}

/** Count iteration commits (the initial "initial" commit is not counted). */
export function commits(repo) {
  return gitExec(repo, ["rev-list", "--count", "--grep=foreveragent", "HEAD"]).then((count) =>
    Number.parseInt(count, 10) || 0,
  );
}

export async function readRepoFile(repo, rel) {
  try {
    return await readFile(path.join(repo, rel), "utf8");
  } catch {
    return null;
  }
}

export function eventTypes(events) {
  return events.map((event) => event.type);
}
