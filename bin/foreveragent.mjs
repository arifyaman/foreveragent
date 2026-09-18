#!/usr/bin/env node
// foreveragent - a minimal autonomous agent loop.
//
// Run pi (or a pi-compatible binary) in a loop: each iteration makes one
// small step towards an objective, the orchestrator commits successes and
// rolls back failures, and model errors trigger a failover to the next model
// in the list.

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolveConfig } from "../src/config.mjs";
import { newRunId, runLoop } from "../src/run.mjs";
import { buildIterationPrompt } from "../src/prompts.mjs";
import { parseDuration } from "../src/log.mjs";
import { spawnRunInTab, readState, stopRun, tailLog } from "../src/herdr.mjs";

const BIN_PATH = fileURLToPath(import.meta.url);

const HELP = `foreveragent - run pi until the objective is met, committing progress each iteration

Usage:
  foreveragent <objective> [options]
  foreveragent spawn <objective> [options]     start a run in a new herdr tab
  foreveragent status [run-id]                 show the latest (or given) run state
  foreveragent logs [run-id] [-n lines]        tail the run log
  foreveragent stop [run-id]                   stop the active run (SIGINT)

Run options:
  --models <a,b,c>            ordered model list (provider/model); failover order
  --model <provider/model>    single model (overrides --models)
  --thinking <level>          pi thinking level (off/minimal/low/medium/high)
  --config <path>             config file (default: foreveragent.json in repo root)
  --max-iterations <n>        stop after n iterations (default: 0 = unlimited)
  --max-consecutive-failures <n>   stop after n consecutive failed iterations (default 3)
  --max-no-ops <n>            stop after n consecutive no-op iterations (default 3)
  --max-wall-time <dur>       stop after a wall-time cap, e.g. 8h, 45m (default: 0)
  --agent-timeout <dur>       per-iteration agent timeout (default: 30m)
  --prevent-sleep <on|off>    prevent system sleep via systemd-inhibit (Linux) (default: on)
  --stop-when <condition>     end when the agent reports this condition is met
  --branch <name>             create and switch to a new branch first
  --allow-dirty               start even with uncommitted changes
  --pi-bin <path>             agent binary (default: pi)
  --dry-run                   print the resolved config and iteration 1 prompt, exit
  --json                      print the final state as JSON
  -h, --help                  this help

Config file (foreveragent.json):
  {
    "models": ["llama.cpp/Qwen3.8-27B-UD-IQ4_XS", "github-copilot/claude-sonnet-5"],
    "thinking": "off",
    "maxIterations": 0,
    "maxConsecutiveFailures": 3,
    "maxNoOps": 3,
    "maxWallTimeMs": 0,
    "agentTimeoutMs": 1800000,
    "failover": { "cooldownMs": 300000, "backoffBaseMs": 5000, "backoffMaxMs": 900000, "rateLimitMaxWaitMs": 3600000 },
    "piBin": "pi"
  }
`;

function parseArgs(argv) {
  const options = { positionals: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const takeValue = (name) => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`missing value for ${name}`);
      return value;
    };
    switch (arg) {
      case "-h":
      case "--help":
        options.help = true;
        break;
      case "--models": {
        // Greedy: consume all following non-flag args so both
        // "--models a/b,c/d" and "--models a/b c/d" work. The objective must
        // be the first positional (before any flag) to avoid ambiguity.
        const values = [];
        while (i + 1 < argv.length && !argv[i + 1].startsWith("-")) values.push(argv[++i]);
        if (values.length === 0) throw new Error("missing value for --models");
        options.models = values.flatMap((value) => value.split(",")).map((s) => s.trim()).filter(Boolean);
        break;
      }
      case "--model":
        options.model = takeValue(arg);
        break;
      case "--thinking":
        options.thinking = takeValue(arg);
        break;
      case "--config":
        options.config = takeValue(arg);
        break;
      case "--max-iterations":
        options.maxIterations = Number.parseInt(takeValue(arg), 10);
        break;
      case "--max-consecutive-failures":
        options.maxConsecutiveFailures = Number.parseInt(takeValue(arg), 10);
        break;
      case "--max-no-ops":
        options.maxNoOps = Number.parseInt(takeValue(arg), 10);
        break;
      case "--max-wall-time":
        options.maxWallTimeMs = parseDuration(takeValue(arg));
        break;
      case "--agent-timeout":
        options.agentTimeoutMs = parseDuration(takeValue(arg));
        break;
      case "--stop-when":
        options.stopWhen = takeValue(arg);
        break;
      case "--branch":
        options.branch = takeValue(arg);
        break;
      case "--allow-dirty":
        options.allowDirty = true;
        break;
      case "--prevent-sleep":
        options.preventSleep = takeValue(arg); // "on" | "off"
        break;
      case "--pi-bin":
        options.piBin = takeValue(arg);
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "-n":
        options.lines = Number.parseInt(takeValue(arg), 10);
        break;
      default:
        if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`);
        options.positionals.push(arg);
    }
  }
  return options;
}

async function loadConfigFile(repoDir, explicitPath) {
  const configPath = explicitPath || path.join(repoDir, "foreveragent.json");
  try {
    const raw = await readFile(configPath, "utf8");
    return { config: JSON.parse(raw), configPath };
  } catch (error) {
    if (explicitPath) throw new Error(`cannot read config ${configPath}: ${error.message}`);
    return { config: {}, configPath: null };
  }
}

function overridesFromOptions(options) {
  const overrides = {};
  if (options.model) overrides.models = [options.model];
  if (options.models) overrides.models = options.models;
  if (options.thinking !== undefined) overrides.thinking = options.thinking;
  for (const key of ["maxIterations", "maxConsecutiveFailures", "maxNoOps", "maxWallTimeMs", "agentTimeoutMs", "piBin"]) {
    if (options[key] !== undefined) overrides[key] = options[key];
  }
  return overrides;
}

/**
 * Re-exec the whole run under systemd-inhibit (Linux) so the machine does
 * not sleep overnight. Returns the exit code when a re-exec happened, or
 * null to continue in-process.
 */
async function preventSleepGuard(options) {
  if (options.preventSleep === "off") return null;
  if (process.platform !== "linux") return null;
  if (process.env.FA_INHIBITED === "1") return null;
  let hasInhibit = false;
  try {
    const { execFileSync } = await import("node:child_process");
    execFileSync("which", ["systemd-inhibit"], { stdio: "ignore" });
    hasInhibit = true;
  } catch {
    hasInhibit = false;
  }
  if (!hasInhibit) {
    console.log("note: systemd-inhibit not found; sleep prevention skipped");
    return null;
  }
  const { spawn } = await import("node:child_process");
  const child = spawn(
    "systemd-inhibit",
    [
      "--what=idle",
      "--what=suspend",
      "--what=handle-lid-switch",
      "--who=foreveragent",
      `--why=foreveragent run on ${process.cwd()}`,
      "--mode",
      "block",
      process.execPath,
      BIN_PATH,
      ...process.argv.slice(2),
    ],
    { stdio: "inherit", env: { ...process.env, FA_INHIBITED: "1" } },
  );
  const forward = (name) => {
    process.on(name, () => {
      try {
        child.kill(name === "SIGINT" ? "SIGINT" : "SIGTERM");
      } catch {
        /* already gone */
      }
    });
  };
  forward("SIGINT");
  forward("SIGTERM");
  const code = await new Promise((resolve) => child.on("close", (c) => resolve(c ?? 1)));
  return code;
}

async function commandRun(options) {
  const repo = process.cwd();
  const objective = options.positionals[0];
  if (!objective) {
    console.error(HELP);
    process.exit(1);
  }

  const { config: fileConfig, configPath } = await loadConfigFile(repo, options.config);
  const config = resolveConfig(fileConfig, overridesFromOptions(options));

  if (options.dryRun) {
    console.log(`config file:   ${configPath || "(none - defaults)"}`);
    console.log(`models:        ${config.models.map((m) => m.model).join(" -> ")}`);
    console.log(`maxIterations: ${config.maxIterations || "unlimited"}`);
    console.log(`maxWallTime:   ${config.maxWallTimeMs ? config.maxWallTimeMs / 60000 + "m" : "unlimited"}`);
    console.log("");
    console.log(buildIterationPrompt({ n: 1, runId: "<runId>", objective, stopWhen: options.stopWhen }));
    return 0;
  }

  const code = await preventSleepGuard(options);
  if (code !== null) return code;

  const controller = new AbortController();
  const onSignal = (name) => {
    if (controller.signal.aborted) return;
    console.log(`\nreceived ${name}, stopping after this agent call...`);
    controller.abort();
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  const runId = newRunId();
  const state = await runLoop({
    repo,
    objective,
    stopWhen: options.stopWhen,
    config,
    runId,
    branch: options.branch,
    allowDirty: options.allowDirty,
    signal: controller.signal,
  });
  if (options.json) {
    console.log(JSON.stringify(state, null, 2));
  }
  return state.exitCode ?? 0;
}

async function commandSpawn(options) {
  const repo = process.cwd();
  const objective = options.positionals[0];
  if (!objective) {
    console.error("usage: foreveragent spawn <objective> [run options...]");
    process.exit(1);
  }

  // Resolve the config to validate the model list before detaching the run.
  const { config: fileConfig } = await loadConfigFile(repo, options.config);
  resolveConfig(fileConfig, overridesFromOptions(options));

  // Build the argv to send to the tab (flags only; values re-parsed there).
  const argv = [objective];
  if (options.models) argv.push("--models", ...options.models);
  if (options.model) argv.push("--model", options.model);
  if (options.thinking !== undefined) argv.push("--thinking", options.thinking);
  if (options.config !== undefined) argv.push("--config", options.config);
  if (options.branch !== undefined) argv.push("--branch", options.branch);
  if (options.piBin !== undefined) argv.push("--pi-bin", options.piBin);
  // Durations are re-parsed on the far side, so send them in human units.
  const durationArg = (ms) => {
    if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
    if (ms % 60_000 === 0) return `${ms / 60_000}m`;
    if (ms % 1000 === 0) return `${ms / 1000}s`;
    return `${ms}ms`;
  };
  for (const [key, flag, isDuration] of [
    ["maxIterations", "--max-iterations", false],
    ["maxConsecutiveFailures", "--max-consecutive-failures", false],
    ["maxNoOps", "--max-no-ops", false],
    ["maxWallTimeMs", "--max-wall-time", true],
    ["agentTimeoutMs", "--agent-timeout", true],
  ]) {
    if (options[key] !== undefined) argv.push(flag, isDuration ? durationArg(options[key]) : String(options[key]));
  }
  if (options.stopWhen !== undefined) argv.push("--stop-when", options.stopWhen);
  if (options.allowDirty) argv.push("--allow-dirty");
  if (options.dryRun) argv.push("--dry-run");

  const label = (objective.match(/^[a-z0-9]+/i) || ["fa"]).slice(0, 8)[0] || "fa";
  const { tabId, paneId, command } = await spawnRunInTab({ repo, argv, label: `fa-${label}` });
  console.log(`started foreveragent in herdr tab ${tabId} (pane ${paneId})`);
  console.log(`command: ${command}`);
  console.log(`watch:   herdr tab focus ${tabId}`);
  console.log(`status:  foreveragent status`);
  return 0;
}

async function commandStatus(options) {
  const repo = process.cwd();
  const found = await readState(repo, options.positionals[0]);
  if (!found) {
    console.log("no runs found");
    return 1;
  }
  console.log(`run dir: ${found.dir}`);
  console.log(JSON.stringify(found.state, null, 2));
  return 0;
}

async function commandLogs(options) {
  const repo = process.cwd();
  const { dir, entries } = await tailLog(repo, options.positionals[0], options.lines ?? 30);
  console.log(`run dir: ${dir}\n`);
  for (const entry of entries) {
    const time = entry.ts ? entry.ts.slice(11, 19) : "        ";
    const detail = entry.message ? ` ${String(entry.message).slice(0, 120)}` : "";
    console.log(`[${time}] ${entry.type} ${entry.model || ""}${detail}`);
  }
  return 0;
}

async function commandStop(options) {
  const repo = process.cwd();
  const result = await stopRun(repo, options.positionals[0]);
  if (!result.stopped) {
    console.error(result.note || "stop failed");
    return 1;
  }
  console.log(result.note);
  return 0;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    console.log(HELP);
    process.exit(argv.length === 0 ? 1 : 0);
  }
  const [subcommand, ...rest] = argv;
  if (["spawn", "status", "logs", "stop"].includes(subcommand)) {
    const options = parseArgs(rest);
    let code;
    if (subcommand === "spawn") code = await commandSpawn(options);
    else if (subcommand === "status") code = await commandStatus(options);
    else if (subcommand === "logs") code = await commandLogs(options);
    else code = await commandStop(options);
    process.exit(code);
  }
  const options = parseArgs(argv);
  const code = await commandRun(options);
  process.exit(code);
}

main().catch((error) => {
  console.error(`foreveragent: ${error.message}`);
  process.exit(1);
});
