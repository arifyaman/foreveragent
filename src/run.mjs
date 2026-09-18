// The orchestrator loop: build a prompt, run one agent iteration, commit on
// success, roll back on failure, fail over models on model errors, and stop
// when a condition is met.

import path from "node:path";
import { mkdir } from "node:fs/promises";
import { appendFileSync, writeFileSync } from "node:fs";
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
import { Failover } from "./failover.mjs";
import { runPi } from "./agent.mjs";
import { buildIterationPrompt } from "./prompts.mjs";
import { RunLog, formatDuration } from "./log.mjs";
import { checkoutNewBranch } from "./git.mjs";

const RUN_DIRNAME = ".foreveragent";

export function newRunId() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

async function sleepAbortable(ms, signal) {
  if (signal?.aborted) return false;
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(why) {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve(!why);
    }
    signal?.addEventListener("abort", () => done(true), { once: true });
  });
}

function firstLine(text) {
  return String(text).split("\n").find((line) => line.trim()) || "";
}

function appendNotes(runDir, text) {
  appendFileSync(path.join(runDir, "notes.md"), text + "\n");
}

function notesEntry({ iteration, model, outcome }) {
  const lines = [];
  lines.push(`## Iteration ${iteration} - ${outcome.state} (model: ${model})`);
  if (outcome.summary) lines.push(`Summary: ${outcome.summary}`);
  for (const change of outcome.changes || []) lines.push(`- ${change}`);
  if ((outcome.learnings || []).length > 0) {
    lines.push("Learnings:");
    for (const learning of outcome.learnings) lines.push(`- ${learning}`);
  }
  return lines.join("\n");
}

/**
 * Run the whole loop. Returns the final state object.
 *
 * @param options {
 *   repo, objective, stopWhen?, config, runId, branch?, allowDirty?,
 *   signal, print?(message)
 * }
 */
export async function runLoop(options) {
  const {
    repo,
    objective,
    stopWhen,
    config,
    runId,
    branch,
    allowDirty = false,
    signal,
    print = console.log,
  } = options;

  const runDir = path.join(repo, RUN_DIRNAME, "runs", runId);
  await mkdir(runDir, { recursive: true });
  await ensureExcluded(repo, RUN_DIRNAME);
  const log = new RunLog(runDir, print);

  const state = {
    runId,
    objective,
    stopWhen: stopWhen || null,
    branch: null,
    startedAt: new Date().toISOString(),
    iteration: 0,
    commits: 0,
    failures: 0,
    noOps: 0,
    currentModel: config.models[0].model,
    modelStates: [],
    status: "running",
    reason: null,
    pid: process.pid,
    repo,
  };

  // --- setup ---------------------------------------------------------------
  if (!(await isGitRepo(repo))) {
    throw new Error(`${repo} is not a git repository (run: git init)`);
  }
  if (!(await hasHead(repo))) {
    throw new Error(`${repo} has no commits yet (make an initial commit first)`);
  }
  const dirty = await status(repo);
  if (!Array.isArray(dirty)) throw dirty.error || new Error("git status failed");
  if (dirty.length > 0 && !allowDirty) {
    throw new Error(
      `working tree is not clean (${dirty.length} uncommitted changes); commit or stash them first, or pass --allow-dirty`,
    );
  }

  if (branch) {
    const result = await checkoutNewBranch(repo, branch);
    if (!result.ok) throw new Error(`git checkout -b ${branch} failed: ${result.error}`);
  }
  state.branch = await branchName(repo);
  const startHead = await headShort(repo);

  writeFileSync(
    path.join(runDir, "prompt.md"),
    `# Objective\n\n${objective}\n${stopWhen ? `\n# Stop Condition\n\n${stopWhen}\n` : ""}`,
    "utf8",
  );
  appendNotes(
    runDir,
    [
      "# Run notes",
      "",
      `Objective: ${objective}`,
      stopWhen ? `Stop condition: ${stopWhen}` : null,
      `Models (priority): ${config.models.map((m) => m.model).join(", ")}`,
      `Started: ${state.startedAt}`,
      "",
    ]
      .filter((line) => line !== null)
      .join("\n"),
  );

  const failover = new Failover(config.models, config.failover);
  const startedMs = Date.now();
  const stateFile = path.join(runDir, "state.json");
  // Synchronous so the on-disk state is never stale at exit (used by
  // `foreveragent stop` to find the live pid).
  const persistState = () => {
    state.currentModel = failover.current().model;
    state.modelStates = failover.summary();
    try {
      writeFileSync(stateFile, JSON.stringify(state, null, 2));
    } catch {
      /* state persistence must never kill the run */
    }
  };

  const finish = async (reason, exitCode) => {
    state.status = exitCode === 0 ? "complete" : "aborted";
    state.reason = reason;
    state.exitCode = exitCode;
    state.finishedAt = new Date().toISOString();
    persistState();
    const work = await diffStat(repo, startHead).catch(() => "");
    log.event("run_end", { reason, ...state, work }, null);
    printSummary(state, reason, work, startHead, startedMs, runDir);
    return state;
  };

  log.event(
    "run_start",
    {
      objective,
      branch: state.branch,
      startHead,
      models: config.models.map((m) => m.model),
      maxIterations: config.maxIterations || null,
      maxWallTimeMs: config.maxWallTimeMs || null,
      stopWhen: stopWhen || null,
    },
    null,
  );
  log.info(`foreveragent run ${runId} on branch ${state.branch} (head ${startHead})`);
  log.info(`objective: ${objective.slice(0, 120)}${objective.length > 120 ? "..." : ""}`);
  log.info(`models: ${config.models.map((m) => m.model).join(" -> ")}`);
  persistState();

  // --- main loop -----------------------------------------------------------
  let consecutiveFailures = 0;
  let consecutiveNoOps = 0;

  while (!signal.aborted) {
    if (config.maxIterations > 0 && state.iteration >= config.maxIterations) {
      return finish("max_iterations", 0);
    }
    if (config.maxWallTimeMs > 0 && Date.now() - startedMs > config.maxWallTimeMs) {
      return finish("max_wall_time", 0);
    }

    state.iteration += 1;
    const iteration = state.iteration;
    const prompt = buildIterationPrompt({ n: iteration, runId, objective, stopWhen });
    log.info(`--- iteration ${iteration} ---`);

    // Inner loop: model failover retries the same iteration.
    let outcome;
    let usedModel = failover.current();
    let attempt = 0;

    for (;;) {
      attempt += 1;
      usedModel = failover.current();
      log.info(`  model: ${usedModel.model}${usedModel.thinking ? ` (thinking: ${usedModel.thinking})` : ""}${attempt > 1 ? ` [attempt ${attempt}]` : ""}`);
      const iterLogPath = path.join(runDir, `iteration-${iteration}-attempt-${attempt}.jsonl`);
      outcome = await runPi({
        bin: config.piBin,
        prompt,
        cwd: repo,
        model: usedModel.model,
        thinking: usedModel.thinking,
        timeoutMs: config.agentTimeoutMs,
        logPath: iterLogPath,
        signal,
      });

      if (outcome.aborted || signal.aborted) {
        return finish("interrupted", 2);
      }
      if (outcome.ok) {
        failover.succeed(usedModel.model);
        break;
      }

      const kind = outcome.kind || "unknown";
      log.event(
        "agent_error",
        { iteration, attempt, model: usedModel.model, kind, message: String(outcome.message).slice(0, 800) },
        `  ! ${usedModel.model}: ${kind} - ${firstLine(String(outcome.message)).slice(0, 200)}`,
      );

      // Roll back any partial work so the retry starts from a clean tree.
      await rollback(repo).catch(() => {});

      const decision = failover.fail(
        usedModel.model,
        kind,
        kind === "format" ? 60_000 : outcome.waitMs ?? 0,
      );
      // Surface failover bookkeeping (model_cooldown / model_dead) in the run log.
      while (failover.events.length > 0) {
        const event = failover.events.shift();
        log.event(event.type, { ...event, iteration }, null);
      }
      if (decision.abort) {
        return finish("all_models_dead", 2);
      }
      if (failover.hardErrors >= 4 * failover.models.length) {
        return finish("agent_errors_exhausted", 2);
      }
      if (decision.waitMs) {
        log.event("failover_wait", { iteration, waitMs: decision.waitMs }, `  waiting ${formatDuration(decision.waitMs)} before next model attempt`);
        const slept = await sleepAbortable(decision.waitMs, signal);
        if (!slept) return finish("interrupted", 2);
        continue;
      }
      continue; // next model picked; retry same iteration
    }

    // --- outcome handling --------------------------------------------------
    const result = outcome.result;
    const dirtyStatus = await status(repo);
    const hasChanges = Array.isArray(dirtyStatus) && dirtyStatus.length > 0;

    if (result.success && hasChanges) {
      await stageAll(repo);
      const commitResult = await commit(repo, `foreveragent ${iteration}: ${result.summary || "iteration"}`);
      if (commitResult.ok) {
        state.commits += 1;
        consecutiveFailures = 0;
        consecutiveNoOps = 0;
        log.event(
          "iteration_success",
          { iteration, model: usedModel.model, summary: result.summary, usage: outcome.usage },
          `  ok: ${result.summary || "committed"} (commit ${state.commits})`,
        );
        await appendNotes(
          runDir,
          notesEntry({ iteration, model: usedModel.model, outcome: { state: "success", summary: result.summary, changes: result.keyChanges, learnings: result.keyLearnings } }),
        );
        if (result.shouldStop) {
          return finish(stopWhen ? "stop_condition" : "done", 0);
        }
        persistState();
        continue;
      }
      // Commit failed: keep the uncommitted work for the next iteration to
      // repair, and count it as a failure.
      state.failures += 1;
      consecutiveFailures += 1;
      consecutiveNoOps = 0;
      log.event(
        "commit_failed",
        { iteration, model: usedModel.model, error: commitResult.error },
        `  ! commit failed: ${firstLine(String(commitResult.error))} - work kept uncommitted for repair`,
      );
      await appendNotes(
        runDir,
        notesEntry({ iteration, model: usedModel.model, outcome: { state: "commit-failed", summary: result.summary, changes: result.keyChanges, learnings: result.keyLearnings } }),
      );
      if (consecutiveFailures >= config.maxConsecutiveFailures) {
        return finish("consecutive_failures", 2);
      }
      persistState();
      continue;
    }

    if (result.success) {
      // Success with no file changes: a no-op.
      state.noOps += 1;
      consecutiveNoOps += 1;
      log.event(
        "iteration_noop",
        { iteration, model: usedModel.model, summary: result.summary },
        `  no-op: no file changes (${consecutiveNoOps} in a row)`,
      );
      await appendNotes(
        runDir,
        notesEntry({ iteration, model: usedModel.model, outcome: { state: "no-op", summary: result.summary, changes: result.keyChanges, learnings: result.keyLearnings } }),
      );
      if (result.shouldStop) {
        return finish(stopWhen ? "stop_condition" : "done", 0);
      }
      if (consecutiveNoOps >= config.maxNoOps) {
        return finish("stalled", 0);
      }
      persistState();
      continue;
    }

    // Agent-reported failure: roll the work back and try again.
    await rollback(repo).catch(() => {});
    state.failures += 1;
    consecutiveFailures += 1;
    consecutiveNoOps = 0;
    log.event(
      "iteration_failed",
      { iteration, model: usedModel.model, summary: result.summary, learnings: result.keyLearnings },
      `  failed: ${result.summary || "agent reported failure"} (${consecutiveFailures} consecutive)`,
    );
    await appendNotes(
      runDir,
      notesEntry({ iteration, model: usedModel.model, outcome: { state: "failed", summary: result.summary, changes: [], learnings: result.keyLearnings } }),
    );
    if (consecutiveFailures >= config.maxConsecutiveFailures) {
      return finish("consecutive_failures", 2);
    }
    persistState();
  }

  return finish("interrupted", 2);
}

function printSummary(state, reason, work, startHead, startedMs, runDir) {
  const lines = [
    "",
    `=== foreveragent finished: ${reason} ===`,
    `branch:     ${state.branch} (started at ${startHead})`,
    `iterations: ${state.iteration}  (commits: ${state.commits}, failures: ${state.failures}, no-ops: ${state.noOps})`,
    `duration:   ${formatDuration(Date.now() - startedMs)}`,
  ];
  if (work) lines.push(`work:       ${work}`);
  lines.push(
    `models:     ${state.modelStates.map((m) => `${m.model} [${m.state}]`).join(", ")}`,
  );
  lines.push(`run dir:    ${runDir}  (run.log, notes.md, state.json, iteration-*.jsonl)`);
  lines.push("");
  for (const line of lines) console.log(line);
}
