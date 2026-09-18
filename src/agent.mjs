// Run one iteration of the pi coding agent in non-interactive JSON mode and
// parse the JSONL stream into a structured outcome.
//
// Invocation: pi -p --mode json --no-session --approve --model <provider/id>
// The prompt goes to stdin. The stream is tee'd to an iteration log file.

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { Failover, classifyModelError } from "./failover.mjs";
import { parseAgentResult } from "./jsonx.mjs";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record, names) {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function numberField(record, names) {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "number") return value;
  }
  return undefined;
}

function textFromAssistantMessage(message) {
  if (!isRecord(message)) return "";
  if (typeof message.text === "string") return message.text;
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map((block) => {
        if (typeof block === "string") return block;
        if (isRecord(block) && typeof block.text === "string") return block.text;
        if (isRecord(block) && typeof block.content === "string") return block.content;
        return "";
      })
      .join("");
  }
  return "";
}

/**
 * Run one pi iteration.
 *
 * @param options {
 *   bin, prompt, cwd, model, thinking?, timeoutMs, logPath?, signal?
 * }
 * @returns Promise<{
 *   ok: true, text: string, usage: object, stopReason: string?,
 *   result?: AgentResult,          // parsed JSON result, if any
 *   resultError?: "no_json",       // when the final text has no JSON result
 * } | {
 *   ok: false, message: string, exitCode: number?, stopReason: string?,
 *   usage: object,
 * }>
 */
export function runPi(options) {
  const {
    bin = process.env.FA_PI_BIN || "pi",
    prompt,
    cwd,
    model,
    thinking,
    timeoutMs = 30 * 60_000,
    logPath,
    signal,
  } = options;

  const piArgs = [
    "-p",
    "--mode",
    "json",
    "--no-session",
    "--approve",
    "--model",
    model,
  ];
  if (thinking) piArgs.push("--thinking", thinking);

  // Allow scripts (e.g. test doubles) as the agent binary: run JS files with
  // node so no executable bit is needed.
  const isScript = /\.(mjs|cjs|js)$/i.test(bin);
  const spawnBin = isScript ? process.execPath : bin;
  const args = isScript ? [bin, ...piArgs] : piArgs;

  return new Promise((resolve) => {
    const child = spawn(spawnBin, args, {
      cwd,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    const logStream = logPath ? createWriteStream(logPath, { flags: "a" }) : null;
    let stderr = "";
    let finished = false;
    let timedOut = false;
    let abortRequested = false;

    const usageByMessageKey = new Map();
    let lastAssistantMessage = null;
    let totalUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0 };

    const updateUsage = (message) => {
      if (!isRecord(message) || !isRecord(message.usage)) return;
      const usage = message.usage;
      const key =
        stringField(message, ["responseId", "id"]) ||
        (typeof message.timestamp === "number" ? `ts:${message.timestamp}` : undefined) ||
        `seq:${usageByMessageKey.size}`;
      const entry = {
        input: numberField(usage, ["input"]) ?? 0,
        output: numberField(usage, ["output"]) ?? 0,
        cacheRead: numberField(usage, ["cacheRead"]) ?? 0,
        cacheWrite: numberField(usage, ["cacheWrite"]) ?? 0,
        totalTokens: numberField(usage, ["totalTokens"]) ?? 0,
        reasoning: numberField(usage, ["reasoning"]) ?? 0,
      };
      usageByMessageKey.set(key, entry);
      totalUsage = [...usageByMessageKey.values()].reduce(
        (acc, item) => {
          acc.inputTokens += item.input;
          acc.outputTokens += item.output;
          acc.cacheReadTokens += item.cacheRead;
          acc.totalTokens += item.totalTokens;
          return acc;
        },
        { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0 },
      );
    };

    const rememberAssistant = (message) => {
      if (!isRecord(message) || message.role !== "assistant") return;
      lastAssistantMessage = message;
      updateUsage(message);
    };

    // --- stdout: JSONL stream, tee'd to the iteration log -----------------
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (logStream) logStream.write(chunk);
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (!isRecord(event)) continue;
        if (event.type === "message_end" || event.type === "turn_end") {
          rememberAssistant(event.message);
        } else if (event.type === "agent_end" && Array.isArray(event.messages) && !lastAssistantMessage) {
          for (let i = event.messages.length - 1; i >= 0; i -= 1) {
            if (isRecord(event.messages[i]) && event.messages[i].role === "assistant") {
              rememberAssistant(event.messages[i]);
              break;
            }
          }
        }
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (logStream) logStream.write(`{"type":"stderr","text":${JSON.stringify(chunk)}}\n`);
    });

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      killChild();
    }, timeoutMs);

    const onAbort = () => {
      abortRequested = true;
      killChild();
    };
    signal?.addEventListener("abort", onAbort);

    function killChild() {
      if (finished) return;
      try {
        if (child.pid) process.kill(-child.pid, "SIGTERM");
      } catch {
        try {
          child.kill("SIGTERM");
        } catch {
          /* already gone */
        }
      }
      setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }, 10_000).unref();
    }

    child.on("error", (error) => {
      // Spawn failed (ENOENT/EACCES): report it directly, do not fall
      // through to the exit-code path (which would swallow the reason).
      if (finished) return;
      finished = true;
      clearTimeout(timeoutHandle);
      signal?.removeEventListener("abort", onAbort);
      logStream?.end();
      resolve({
        ok: false,
        message: `failed to start agent ${spawnBin}: ${error.message}`,
        exitCode: -1,
        stopReason: undefined,
        usage: totalUsage,
        kind: /ENOENT/.test(error.message) ? "not_found" : "unknown",
      });
    });

    child.on("close", (code) => {
      finish({ ok: true, exitCode: code, raw: true });
    });

    function finish(reason) {
      if (finished) return;
      finished = true;
      clearTimeout(timeoutHandle);
      signal?.removeEventListener("abort", onAbort);
      if (logStream) {
        logStream.end();
      }

      const finalText = textFromAssistantMessage(lastAssistantMessage).trim();
      const stopReason = isRecord(lastAssistantMessage) ? lastAssistantMessage.stopReason : undefined;
      const errorMessage = isRecord(lastAssistantMessage)
        ? stringField(lastAssistantMessage, ["errorMessage", "error", "message"])
        : undefined;

      const usage = totalUsage;

      if (timedOut) {
        resolve({
          ok: false,
          message: `agent timed out after ${Math.max(1, Math.round(timeoutMs / 1000))}s`,
          exitCode: reason.exitCode,
          stopReason,
          usage,
          kind: "timeout",
        });
        return;
      }
      if (abortRequested) {
        resolve({ ok: false, message: "agent aborted", exitCode: reason.exitCode, stopReason, usage, aborted: true });
        return;
      }

      // Model/provider errors surface either as a non-zero exit with an
      // Error line on stderr, or as an assistant message with stopReason
      // "error" carrying an errorMessage.
      if (stopReason === "error" || stopReason === "aborted") {
        const message = errorMessage || finalText || `agent ended with stopReason=${stopReason}`;
        const { kind, waitMs } = classifyModelError(message, 60 * 60_000);
        resolve({ ok: false, message, exitCode: reason.exitCode, stopReason, usage, kind, waitMs });
        return;
      }
      if (reason.exitCode !== 0) {
        const combined = [errorMessage, finalText, stderr].filter(Boolean).join("\n");
        const { kind, waitMs } = classifyModelError(combined, 60 * 60_000);
        resolve({
          ok: false,
          message: [stderr.trim(), errorMessage, finalText].filter(Boolean).join("\n") || `agent exited with code ${reason.exitCode}`,
          exitCode: reason.exitCode,
          stopReason,
          usage,
          kind: kind === "none" ? "unknown" : kind,
          waitMs: kind === "none" ? 0 : waitMs,
        });
        return;
      }

      if (!finalText) {
        resolve({
          ok: false,
          message: "agent produced no text output",
          exitCode: 0,
          stopReason,
          usage,
          kind: "unknown",
        });
        return;
      }

      const parsed = parseAgentResult(finalText);
      if (parsed.error) {
        resolve({
          ok: false,
          message: `agent output has no valid JSON result: ${finalText.slice(0, 400)}`,
          exitCode: 0,
          stopReason,
          usage,
          kind: "format",
          text: finalText,
        });
        return;
      }
      resolve({ ok: true, text: finalText, result: parsed.result, stopReason, usage });
    }

    // Prompt on stdin (pi reads it when piped).
    child.stdin.on("error", () => {
      /* EPIPE if the agent exits before reading; harmless */
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}
