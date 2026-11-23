// Driver for the tabs interrupt tests. Runs runTabs() (fallback path,
// workspaceId: null) and prints a final one-line summary at the end.
// Usage: node tabs-interrupt-driver.mjs <repo> <piBin>
// Env: FA_TEST_MAX_ITERATIONS (default 0), FA_TEST_AGENT_TIMEOUT_MS (default 120s)

import process from "node:process";
import { runTabs } from "../src/tabs.mjs";

const repo = process.argv[2];
const piBin = process.argv[3];

const config = {
  models: [{ model: "a/m1", thinking: "low" }],
  maxIterations: Number(process.env.FA_TEST_MAX_ITERATIONS ?? 0),
  maxConsecutiveFailures: 1000,
  maxNoOps: 0,
  maxWallTimeMs: 0,
  agentTimeoutMs: Number(process.env.FA_TEST_AGENT_TIMEOUT_MS ?? 120_000),
  piBin,
};

const state = await runTabs({
  repo,
  objective: "test objective: create partial_work.txt",
  stopWhen: undefined,
  config,
  runId: `test-${Date.now()}`,
  branch: undefined,
  allowDirty: false,
  workspaceId: null,
  print: console.log,
});

console.log(
  "FINAL_STATE " +
    JSON.stringify({
      status: state.status,
      reason: state.reason,
      iteration: state.iteration,
      commits: state.commits,
      failures: state.failures,
      noOps: state.noOps,
    }),
);
