// tabs.mjs - Main orchestration for the `foreveragent tabs` subcommand.
//
// Creates a new herdr tab for each iteration, runs pi in a child process
// within that tab, and coordinates commit/rollback/notes between iterations.
// Tabs are never auto-closed.

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import os from "node:os";
import net from "node:net";

import {
  isGitRepo,
  status,
  branchName,
  ensureExcluded,
  hasHead,
  stageAll,
  commit,
  rollback,
  headShort,
  diffStat,
} from "./git.mjs";
import { checkoutNewBranch } from "./git.mjs";
import { newRunId } from "./run.mjs";
import { buildIterationPrompt } from "./prompts.mjs";
import { RunLog, formatDuration } from "./log.mjs";
import { Failover } from "./failover.mjs";

const RUN_DIRNAME = ".foreveragent";

// Path to the child script, resolved relative to this file's location
const __filename = fileURLToPath(import.meta.url);
const TABS_CHILD_SCRIPT = join(dirname(__filename), "tabs-child.mjs");

const ARTIFACT_EXCLUDES = [
  "__pycache__/", "*.pyc", "*.pyo", ".pytest_cache/", ".mypy_cache/",
  ".coverage", "htmlcov/", "node_modules/",
];

// ---------------------------------------------------------------------------
// Herdr tab management
// ---------------------------------------------------------------------------

function herdrBin() { return process.env.HERDR_BIN_PATH || "herdr"; }

function exec(cmd, args, timeoutMs = 15_000) {
  return new Promise((resolve) => {
    import("node:child_process").then(({ execFile }) => {
      execFile(cmd, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: timeoutMs }, (error, stdout, stderr) => {
        resolve({
          ok: !error,
          error: error ? (stderr || error.message).trim() : undefined,
          stdout: (stdout || "").trim(),
          stderr: (stderr || "").trim(),
        });
      });
    }).catch(() => resolve({ ok: false, error: "exec failed" }));
  });
}

export async function createTab(workspaceId, cwd, label) {
  const result = await exec(herdrBin(), [
    "tab", "create", "--workspace", workspaceId,
    "--cwd", cwd, "--label", label.slice(0, 30), "--no-focus",
  ]);
  if (!result.ok) throw new Error(`herdr tab create failed: ${result.error}`);
  const parsed = JSON.parse(result.stdout);
  const tabId = parsed?.result?.tab?.tab_id;
  const paneId = parsed?.result?.root_pane?.pane_id;
  if (!tabId || !paneId) throw new Error(`tab create returned no tab/pane`);
  return { tabId, paneId };
}

async function sendToPane(paneId, text) {
  try { await exec(herdrBin(), ["pane", "send-keys", paneId, text]); } catch { /* non-critical */ }
}

/** Try to reuse an existing idle pane as orchestrator (best effort). */
async function findReusableTab(workspaceId, cwd) {
  const result = await exec(herdrBin(), ["pane", "list", "--workspace", workspaceId]);
  if (!result.ok) return null;
  const parsed = JSON.parse(result.stdout);
  const panes = parsed?.result?.panes || [];
  const idle = panes.find((p) => p.agent_status === "unknown" || !p.agent);
  if (!idle) return null;
  // Verify pane is alive by reading scrollback
  const readResult = await exec(herdrBin(), ["pane", "read", idle.pane_id, "--source", "visible", "--lines", "1"]);
  if (!readResult.ok) return null;
  return { tabId: idle.tab_id, paneId: idle.pane_id };
}

export async function spawnIterationTab(workspaceId, cwd, label, childConfig) {
  // Always create a NEW tab for each iteration (never reuse the orchestrator)
  const { tabId, paneId } = await createTab(workspaceId, cwd, label);

  // Clear any stale result so the poll loop doesn't read a previous iteration
  try { rmSync(join(childConfig.runDir, "iter-result.json")); } catch {}

  // Write config to a shared file in the run dir
  writeFileSync(join(childConfig.runDir, "child-config.json"), JSON.stringify(childConfig));

  // Run the child inside the iteration pane. `herdr pane run` executes the
  // command in the pane's shell (output stays visible in the pane) and returns
  // immediately, so the orchestrator then polls iter-result.json for completion.
  const cmd = `FA_RUN_DIR='${childConfig.runDir}' node '${TABS_CHILD_SCRIPT}'`;
  const run = await exec(herdrBin(), ["pane", "run", paneId, cmd], 30_000);
  if (!run.ok) {
    throw new Error(`herdr pane run failed: ${run.error}`);
  }

  return { tabId, paneId };
}

export async function spawnIterationChild(childConfig, signal) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TABS_CHILD_SCRIPT], {
      stdio: ["pipe", "inherit", "inherit"],
      env: { ...process.env, FA_RUN_DIR: childConfig.runDir },
    });
    child.stdin.write(JSON.stringify(childConfig));
    child.stdin.end();
    signal?.addEventListener("abort", () => { try { child.kill("SIGTERM"); } catch {} });
    child.on("close", (code) => {
      const resultPath = join(childConfig.runDir, "iter-result.json");
      let result;
      try { result = JSON.parse(readFileSync(resultPath, "utf8")); }
      catch { result = { ok: false, error: "could not read result file" }; }
      resolve({ result, exitCode: code });
    });
  });
}

// ---------------------------------------------------------------------------
// Notes management
// ---------------------------------------------------------------------------

function appendNotes(runDir, text) {
  appendFileSync(join(runDir, "notes.md"), text + "\n");
}

function notesEntry({ iteration, model, outcome }) {
  const lines = [];
  lines.push(`## Iteration ${iteration} - ${outcome.state} (model: ${model})`);
  if (outcome.summary) lines.push(`Summary: ${outcome.summary}`);
  for (const change of outcome.changes || []) lines.push(`- ${change}`);
  if (outcome.learnings && outcome.learnings.length > 0) {
    lines.push("Learnings:");
    for (const learning of outcome.learnings) lines.push(`- ${learning}`);
  }
  return lines.join("\n");
}

function writeState(runDir, state) {
  writeFileSync(join(runDir, "state.json"), JSON.stringify(state, null, 2));
}

// ---------------------------------------------------------------------------
// Tabs mode orchestrator
// ---------------------------------------------------------------------------

export async function runTabs(options) {
  const {
    repo, objective, stopWhen, config, runId, branch,
    allowDirty = false, workspaceId, print = console.log,
  } = options;

  const runDir = join(repo, RUN_DIRNAME, "runs", runId);
  mkdirSync(runDir, { recursive: true });
  await ensureExcluded(repo, RUN_DIRNAME);
  for (const entry of ARTIFACT_EXCLUDES) await ensureExcluded(repo, entry);
  const log = new RunLog(runDir, print);

  const state = {
    runId, objective, stopWhen: stopWhen || null,
    branch: null, startedAt: new Date().toISOString(),
    iteration: 0, commits: 0, failures: 0, noOps: 0,
    currentModel: config.models[0].model,
    modelStates: [], status: "running", reason: null,
    repo, tabs: [],
  };

  // --- setup ---------------------------------------------------------------
  if (!(await isGitRepo(repo))) throw new Error(`${repo} is not a git repository`);
  if (!(await hasHead(repo))) throw new Error(`${repo} has no commits yet`);
  const dirty = await status(repo);
  if (Array.isArray(dirty) && dirty.length > 0 && !allowDirty) {
    throw new Error(`working tree is not clean (${dirty.length} uncommitted changes)`);
  }
  if (branch) {
    const result = await checkoutNewBranch(repo, branch);
    if (!result.ok) throw new Error(`git checkout -b ${branch} failed: ${result.error}`);
  }
  state.branch = await branchName(repo);
  const startHead = await headShort(repo);

  writeFileSync(join(runDir, "prompt.md"), `# Objective\n\n${objective}\n${stopWhen ? `\n# Stop Condition\n\n${stopWhen}\n` : ""}`, "utf8");
  appendNotes(runDir, [
    "# Run notes", "", `Objective: ${objective}`,
    stopWhen ? `Stop condition: ${stopWhen}` : null,
    `Models (priority): ${config.models.map((m) => m.model).join(", ")}`,
    `Started: ${state.startedAt}`, "",
  ].filter((line) => line !== null).join("\n"));

  const failover = new Failover(config.models, config.failover);
  const startedMs = Date.now();
  let persistState = () => {
    state.currentModel = failover.current().model;
    state.modelStates = failover.summary();
    try { writeState(runDir, state); } catch {}
  };
  persistState();

  const finish = async (reason) => {
    state.status = "complete";
    state.reason = reason;
    state.finishedAt = new Date().toISOString();
    persistState();
    const work = await diffStat(repo, startHead).catch(() => "");
    log.event("run_end", { reason, ...state, work }, null);
    printSummary(state, reason, work, startHead, startedMs, runDir);
    return state;
  };

  log.event("run_start", {
    objective, branch: state.branch, startHead,
    models: config.models.map((m) => m.model),
    maxIterations: config.maxIterations || null, stopWhen: stopWhen || null, mode: "tabs",
  }, null);
  log.info(`[tabs] foreveragent run ${runId} on branch ${state.branch} (head ${startHead})`);
  log.info(`[tabs] objective: ${objective.slice(0, 120)}`);
  log.info(`[tabs] models: ${config.models.map((m) => m.model).join(" -> ")}`);
  log.info(`[tabs] mode: each iteration in its own herdr tab`);

  // --- Tabs management -----------------------------------------------------
  let orchestratorTabId = null, orchestratorPaneId = null;

  if (workspaceId) {
    // Try to reuse an existing orphaned tab
    let reused = await findReusableTab(workspaceId, repo);
    if (reused) {
      orchestratorTabId = reused.tabId;
      orchestratorPaneId = reused.paneId;
      state.orchestratorTabId = orchestratorTabId;
      state.orchestratorPaneId = orchestratorPaneId;
      log.info(`[tabs] reused existing tab: ${orchestratorTabId}`);
    } else {
      // Create a new tab
      try {
        const { tabId, paneId } = await createTab(workspaceId, repo, "foreveragent (tabs)");
        orchestratorTabId = tabId;
        orchestratorPaneId = paneId;
        state.orchestratorTabId = tabId;
        state.orchestratorPaneId = paneId;
        log.info(`[tabs] orchestrator tab: ${tabId}`);
      } catch (error) {
        log.info(`[tabs] could not create orchestrator tab: ${error.message}`);
      }
    }
  }

  // --- Main loop -----------------------------------------------------------
  let consecutiveFailures = 0, consecutiveNoOps = 0;
  let running = true;
  const onSignal = () => { if (!running) return; running = false; log.info("[tabs] received signal, stopping..."); };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  while (running) {
    if (config.maxIterations > 0 && state.iteration >= config.maxIterations) return finish("max_iterations");

    state.iteration += 1;
    const iteration = state.iteration;
    const prompt = buildIterationPrompt({ n: iteration, runId, objective, stopWhen });
    log.info(`[tabs] --- iteration ${iteration} ---`);

    if (orchestratorTabId) {
      try { sendToPane(orchestratorPaneId, `\n\n=== Iteration ${iteration} / ${config.maxIterations || "inf"} - model: ${failover.current().model} ===`); } catch {}
    }

    // Inner loop: model failover
    let outcome, usedModel = failover.current(), attempt = 0;

    for (;;) {
      attempt += 1;
      usedModel = failover.current();
      log.info(`[tabs]   model: ${usedModel.model}${usedModel.thinking ? ` (thinking: ${usedModel.thinking})` : ""}${attempt > 1 ? ` [attempt ${attempt}]` : ""}`);

      try {
        if (workspaceId && existsSync(TABS_CHILD_SCRIPT)) {
          // Spawn in a new herdr tab
          const tabLabel = `Iteration ${iteration}${attempt > 1 ? ` (${attempt})` : ""}`;
          const childConfig = {
            runDir, prompt,
            model: usedModel.model,
            thinking: usedModel.thinking,
            bin: config.piBin,
            cwd: repo,
          };

          const { tabId, paneId } = await spawnIterationTab(
            workspaceId, repo, tabLabel, childConfig,
          );
          log.info(`[tabs]   iteration ${iteration} in tab ${tabId}, pane ${paneId}`);
          state.tabs.push({ iteration, tabId, paneId, status: "spawning" });

          // Poll for result
          let elapsed = 0;
          const maxWaitMs = config.agentTimeoutMs || 30 * 60 * 1000;
          const resultPath = join(runDir, "iter-result.json");

          while (elapsed < maxWaitMs && running && !existsSync(resultPath)) {
            await new Promise((r) => setTimeout(r, 2000));
            elapsed += 2000;
          }

          if (!existsSync(resultPath)) {
            outcome = { ok: false, kind: "timeout", message: `iteration ${iteration} timed out after ${formatDuration(elapsed)}` };
          } else {
            const resultData = JSON.parse(readFileSync(resultPath, "utf8"));
            outcome = {
              ok: resultData.ok, result: resultData.result,
              text: resultData.text, usage: resultData.usage || {},
              kind: resultData.ok ? "success" : (resultData.error || "unknown"),
            };
          }
        } else {
          // Fallback: spawn child directly
          const childConfig = { runDir, prompt, model: usedModel.model, thinking: usedModel.thinking, bin: config.piBin, cwd: repo };
          const { result, exitCode } = await spawnIterationChild(childConfig, null);
          outcome = { ok: result.ok, result: result.result, text: result.text, usage: result.usage || {}, kind: result.ok ? "success" : (result.error || "unknown"), exitCode };
        }
      } catch (error) {
        log.event("iteration_spawn_error", { iteration, attempt, error: error.message }, `[tabs]   ! spawn failed: ${error.message}`);
        outcome = { ok: false, kind: "unknown", message: error.message };
      }

      if (outcome.ok) { failover.succeed(usedModel.model); break; }

      const kind = outcome.kind || "unknown";
      const message = outcome.message || String(outcome.error || "").slice(0, 800);
      log.event("agent_error", { iteration, attempt, model: usedModel.model, kind, message: message.slice(0, 800) },
        `[tabs]   ! ${usedModel.model}: ${kind} - ${message.slice(0, 200)}`);

      await rollback(repo).catch(() => {});

      const decision = failover.fail(usedModel.model, kind, kind === "format" ? 60_000 : 0);
      while (failover.events.length > 0) {
        const event = failover.events.shift();
        log.event(event.type, { ...event, iteration }, null);
      }
      if (decision.abort) return finish("all_models_dead");
      if (failover.hardErrors >= 4 * failover.models.length) return finish("agent_errors_exhausted");
      continue;
    }

    // --- Outcome handling --------------------------------------------------
    const result = outcome.result;
    const dirtyStatus = await status(repo);
    const hasChanges = Array.isArray(dirtyStatus) && dirtyStatus.length > 0;

    if (result && result.success && hasChanges) {
      await stageAll(repo);
      const commitResult = await commit(repo, `foreveragent ${iteration}: ${result.summary || "iteration"}`);
      if (commitResult.ok) {
        state.commits += 1; consecutiveFailures = 0; consecutiveNoOps = 0;
        log.event("iteration_success", { iteration, model: usedModel.model, summary: result.summary },
          `[tabs]   ok: ${result.summary || "committed"} (commit ${state.commits})`);
        appendNotes(runDir, notesEntry({ iteration, model: usedModel.model, outcome: { state: "success", summary: result.summary, changes: result.keyChanges, learnings: result.keyLearnings } }));
        if (result.shouldStop) return finish(stopWhen ? "stop_condition" : "done");
        persistState();
        continue;
      }
      state.failures += 1; consecutiveFailures += 1; consecutiveNoOps = 0;
      log.event("commit_failed", { iteration, model: usedModel.model, error: commitResult.error },
        `[tabs]   ! commit failed: ${String(commitResult.error).slice(0, 200)}`);
      appendNotes(runDir, notesEntry({ iteration, model: usedModel.model, outcome: { state: "commit-failed", summary: result.summary, changes: result.keyChanges, learnings: result.keyLearnings } }));
      if (consecutiveFailures >= config.maxConsecutiveFailures) return finish("consecutive_failures");
      persistState();
      continue;
    }

    if (result && result.success) {
      state.noOps += 1; consecutiveNoOps += 1;
      log.event("iteration_noop", { iteration, model: usedModel.model, summary: result.summary },
        `[tabs]   no-op: no file changes (${consecutiveNoOps} in a row)`);
      appendNotes(runDir, notesEntry({ iteration, model: usedModel.model, outcome: { state: "no-op", summary: result.summary, changes: result.keyChanges, learnings: result.keyLearnings } }));
      if (result.shouldStop) return finish(stopWhen ? "stop_condition" : "done");
      if (consecutiveNoOps >= config.maxNoOps) return finish("stalled");
      persistState();
      continue;
    }

    await rollback(repo).catch(() => {});
    state.failures += 1; consecutiveFailures += 1; consecutiveNoOps = 0;
    log.event("iteration_failed", { iteration, model: usedModel.model, summary: result?.summary },
      `[tabs]   failed: ${result?.summary || "agent reported failure"} (${consecutiveFailures} consecutive)`);
    appendNotes(runDir, notesEntry({ iteration, model: usedModel.model, outcome: { state: "failed", summary: result?.summary, changes: [], learnings: result?.keyLearnings } }));
    if (consecutiveFailures >= config.maxConsecutiveFailures) return finish("consecutive_failures");
    persistState();
  }

  return finish("interrupted");
}

function printSummary(state, reason, work, startHead, startedMs, runDir) {
  const lines = [
    "", `=== foreveragent finished: ${reason} (tabs mode) ===`,
    `branch:     ${state.branch} (started at ${startHead})`,
    `iterations: ${state.iteration}  (commits: ${state.commits}, failures: ${state.failures}, no-ops: ${state.noOps})`,
    `duration:   ${formatDuration(Date.now() - startedMs)}`,
  ];
  if (work) lines.push(`work:       ${work}`);
  lines.push(`models:     ${state.modelStates.map((m) => `${m.model} [${m.state}]`).join(", ")}`);
  lines.push(`run dir:    ${runDir}`);
  lines.push(`orphan tabs: ${state.tabs?.length || 0} (never auto-closed)`);
  lines.push("");
  for (const line of lines) console.log(line);
}
