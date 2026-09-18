// Thin git helpers for the orchestrator. Everything runs with execFile so no
// shell is involved, and commits are unsigned (no GPG prompts overnight).

import { execFile } from "node:child_process";
import { readFile, writeFile, appendFile, stat } from "node:fs/promises";
import path from "node:path";

function git(cwd, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, ...options },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(new Error((stderr || stdout || error.message).trim()), {
            code: error.code,
            stdout: (stdout || "").trim(),
            stderr: (stderr || "").trim(),
          }));
          return;
        }
        resolve({ stdout: (stdout || "").trim(), stderr: (stderr || "").trim() });
      },
    );
  });
}

export async function isGitRepo(cwd) {
  try {
    const { stdout } = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
    return stdout === "true";
  } catch {
    return false;
  }
}

/** Porcelain status lines; empty when the working tree is clean. */
export async function status(cwd) {
  try {
    const { stdout } = await git(cwd, ["status", "--porcelain"]);
    return stdout.length === 0 ? [] : stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  } catch (error) {
    return { error };
  }
}

export async function isClean(cwd) {
  const result = await status(cwd);
  return Array.isArray(result) && result.length === 0;
}

export async function branchName(cwd) {
  const { stdout } = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return stdout;
}

export async function initRepo(cwd) {
  await git(cwd, ["init"]);
}

export async function checkoutNewBranch(cwd, name) {
  try {
    await git(cwd, ["checkout", "-b", name]);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/**
 * Ensure an entry is excluded from git locally via .git/info/exclude.
 * This never touches the working tree, so the clean-tree check stays valid.
 */
export async function ensureExcluded(cwd, entry) {
  const excludePath = path.join(cwd, ".git", "info", "exclude");
  try {
    await stat(excludePath);
  } catch {
    await writeFile(excludePath, `# local exclusions (managed by foreveragent)\n${entry}\n`, "utf8");
    return;
  }
  const current = await readFile(excludePath, "utf8");
  if (current.split("\n").some((line) => line.trim() === entry || line.trim() === `${entry}/`)) return;
  await appendFile(excludePath, (current.endsWith("\n") || current.length === 0 ? "" : "\n") + `${entry}\n`, "utf8");
}

/** True when the repo has at least one commit. */
export async function hasHead(cwd) {
  try {
    await git(cwd, ["rev-parse", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

export async function stageAll(cwd) {
  await git(cwd, ["add", "-A"]);
}

export async function hasIdentity(cwd) {
  try {
    const { stdout } = await git(cwd, ["config", "user.email"]);
    return stdout.length > 0;
  } catch {
    return false;
  }
}

/**
 * Commit all staged changes. Returns { ok, hash?, error? }.
 * Unsigned so GPG never blocks an unattended run.
 */
export async function commit(cwd, message, { authorName = "foreveragent", authorEmail = "foreveragent@localhost" } = {}) {
  const identityArgs = (await hasIdentity(cwd))
    ? []
    : ["-c", `user.name=${authorName}`, "-c", `user.email=${authorEmail}`];
  try {
    const { stdout } = await git(cwd, [
      "-c",
      "commit.gpgsign=false",
      ...(identityArgs.length ? identityArgs : []),
      "commit",
      "-m",
      message,
      "--allow-empty-message",
    ]);
    return { ok: true, output: stdout };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/** Hard-reset the working tree to HEAD (discards uncommitted iteration work). */
export async function rollback(cwd) {
  try {
    await git(cwd, ["reset", "--hard", "HEAD"]);
    await git(cwd, ["clean", "-fd"]);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

export async function headShort(cwd) {
  try {
    const { stdout } = await git(cwd, ["rev-parse", "--short", "HEAD"]);
    return stdout;
  } catch {
    return "none";
  }
}

export async function countCommits(cwd, sinceRef) {
  try {
    const { stdout } = await git(cwd, ["rev-list", "--count", sinceRef]);
    return Number.parseInt(stdout, 10) || 0;
  } catch {
    return 0;
  }
}

export async function diffStat(cwd, sinceRef) {
  try {
    const { stdout } = await git(cwd, ["diff", "--shortstat", sinceRef]);
    return stdout;
  } catch {
    return "";
  }
}
