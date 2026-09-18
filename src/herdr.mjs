// Herdr integration: start a run in a visible herdr tab, stop it, and read
// its logs/status. Requires the herdr CLI (HERDR_BIN_PATH or "herdr" on PATH)
// and a live herdr server; the tab is created in the current workspace
// (HERDR_WORKSPACE_ID) when available.

import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import process from "node:process";

function herdrBin() {
  return process.env.HERDR_BIN_PATH || "herdr";
}

function run(cmd, args, timeoutMs = 15_000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        resolve({ ok: false, error: (stderr || error.message).trim(), stdout: (stdout || "").trim() });
        return;
      }
      resolve({ ok: true, stdout: (stdout || "").trim(), stderr: (stderr || "").trim() });
    });
  });
}

/** Quote a string for POSIX shell. */
export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function latestRunDir(repo) {
  return async () => {
    const runsDir = path.join(repo, ".foreveragent", "runs");
    let entries;
    try {
      entries = await readdir(runsDir, { withFileTypes: true });
    } catch {
      return null;
    }
    const dirs = entries.filter((entry) => entry.isDirectory());
    if (dirs.length === 0) return null;
    const withMtime = await Promise.all(
      dirs.map(async (entry) => {
        try {
          const s = await stat(path.join(runsDir, entry.name));
          return { dir: path.join(runsDir, entry.name), mtime: s.mtimeMs };
        } catch {
          return null;
        }
      }),
    );
    withMtime.sort((a, b) => b.mtime - a.mtime);
    return withMtime[0]?.dir || null;
  };
}

/**
 * One-shot JSON-RPC call over the herdr unix socket.
 */
function herdrSocketPath() {
  return process.env.HERDR_SOCKET_PATH || path.join(os.homedir(), ".config", "herdr", "herdr.sock");
}

export function herdrRpc(method, params) {
  return new Promise((resolve) => {
    const socket = net.connect(herdrSocketPath());
    let buffer = "";
    const finish = (value) => {
      try {
        socket.end();
      } catch {
        /* ignore */
      }
      resolve(value);
    };
    socket.setTimeout(10_000, () => {
      finish({ ok: false, error: "herdr socket timeout" });
    });
    socket.on("connect", () => {
      socket.write(JSON.stringify({ id: "1", method, params }) + "\n");
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const line = buffer.split("\n").find((l) => l.trim().startsWith("{"));
      if (!line) return;
      try {
        const parsed = JSON.parse(line);
        if (parsed.error) finish({ ok: false, error: parsed.error.message || JSON.stringify(parsed.error) });
        else finish({ ok: true, result: parsed.result });
      } catch {
        finish({ ok: false, error: `bad herdr response: ${line.slice(0, 200)}` });
      }
    });
    socket.on("error", (error) => finish({ ok: false, error: error.message }));
  });
}

/**
 * Create a herdr tab in the current workspace and start a foreveragent run in
 * it. Returns { tabId, paneId, command }.
 *
 * The pane is a plain shell, so the command is sent with the pane-level
 * pane.send_text RPC (agent.send-keys only addresses detected agents).
 */
export async function spawnRunInTab({ repo, argv, label, workdir = repo }) {
  const workspace = process.env.HERDR_WORKSPACE_ID;
  if (!workspace) {
    throw new Error("not running inside a herdr workspace (HERDR_WORKSPACE_ID missing); run the command directly instead");
  }
  const bin = herdrBin();
  const command = `cd ${shellQuote(workdir)} && exec ${shellQuote(process.execPath)} ${shellQuote(process.argv[1])} ${argv.map(shellQuote).join(" ")}`;
  const safeLabel = (label || "foreveragent").replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 24) || "foreveragent";

  const created = await run(bin, ["tab", "create", "--workspace", workspace, "--cwd", workdir, "--label", safeLabel, "--no-focus"]);
  if (!created.ok) throw new Error(`herdr tab create failed: ${created.error}`);
  let parsed;
  try {
    parsed = JSON.parse(created.stdout);
  } catch {
    throw new Error(`herdr tab create returned non-JSON: ${created.stdout.slice(0, 200)}`);
  }
  const paneId = parsed?.result?.root_pane?.pane_id;
  const tabId = parsed?.result?.tab?.tab_id;
  if (!paneId || !tabId) throw new Error(`herdr tab create: missing pane/tab id in ${created.stdout.slice(0, 200)}`);

  const sent = await herdrRpc("pane.send_text", { pane_id: paneId, text: command + "\r" });
  if (!sent.ok) throw new Error(`pane.send_text failed: ${sent.error}`);
  return { tabId, paneId, command };
}

/** Read state.json from a run dir. */
export async function readState(repo, runId) {
  const dir = runId ? path.join(repo, ".foreveragent", "runs", runId) : await latestRunDir(repo)();
  if (!dir) return null;
  try {
    const raw = await readFile(path.join(dir, "state.json"), "utf8");
    return { dir, state: JSON.parse(raw) };
  } catch {
    return null;
  }
}

/** Send SIGINT to the running process recorded in state.json. */
export async function stopRun(repo, runId) {
  const found = await readState(repo, runId);
  if (!found) throw new Error("no run found (no .foreveragent/runs/*/state.json)");
  const { state } = found;
  if (state.status !== "running" || !state.pid) {
    return { stopped: false, state, note: "run is not active" };
  }
  try {
    process.kill(state.pid, "SIGINT");
    return { stopped: true, state, note: `SIGINT sent to pid ${state.pid}` };
  } catch (error) {
    return { stopped: false, state, note: `could not signal pid ${state.pid}: ${error.message}` };
  }
}

/** Tail the run's JSONL log as plain lines. */
export async function tailLog(repo, runId, lines = 30) {
  const found = await readState(repo, runId);
  if (!found) throw new Error("no run found (no .foreveragent/runs/*/state.json)");
  const raw = await readFile(path.join(found.dir, "run.log"), "utf8").catch(() => "");
  const entries = raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .slice(-lines);
  return { dir: found.dir, entries };
}
