// tabs-child.mjs - Child process for a single iteration in tabs mode.
//
// Runs `pi -p --mode json`, renders each event as a readable line to the
// pane (so the user sees tool calls, messages, and the final answer live),
// extracts the final JSON result, writes iter-result.json, and prints a
// visible summary banner when done.

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function out(line = "") {
  // The child's stdout is shown in the iteration pane by `herdr pane run`.
  process.stdout.write(line + "\n");
}

/** Collect all text blocks from a message content (string or block array). */
function messageText(message) {
  if (!message || typeof message !== "object") return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("");
  }
  return "";
}

/** A short human-readable description of a tool call. */
function describeTool(toolName, args) {
  const a = args && typeof args === "object" ? args : {};
  let detail = "";
  if (typeof a.path === "string") detail = a.path;
  else if (typeof a.file_path === "string") detail = a.file_path;
  else if (typeof a.command === "string") detail = a.command.slice(0, 80);
  else if (typeof a.url === "string") detail = a.url;
  else if (typeof a.query === "string") detail = a.query.slice(0, 80);
  else if (Object.keys(a).length) detail = JSON.stringify(a).slice(0, 80);
  const prefix = toolName ? `→ ${toolName}` : "→ tool";
  return detail ? `${prefix} ${detail}` : prefix;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const runDir = process.env.FA_RUN_DIR || process.cwd();
  const config = JSON.parse(readFileSync(join(runDir, "child-config.json"), "utf8"));
  const { model, thinking, bin, cwd, prompt } = config;

  const piBin = bin || process.env.FA_PI_BIN || "pi";
  const isScript = /\.(mjs|cjs|js)$/i.test(piBin);
  const spawnBin = isScript ? process.execPath : piBin;
  const preArgs = isScript ? [piBin] : [];
  const commonArgs = ["-p", "--mode", "json", "--approve", "--model", model];
  if (thinking) commonArgs.push("--thinking", thinking);
  // `--` ends option parsing so the prompt is treated as a positional message.
  const spawnArgs = [...preArgs, ...commonArgs, "--", prompt];

  out("");
  out(`\u2502 pi starting \u2014 model: ${model}${thinking ? ` (thinking: ${thinking})` : ""}`);

  const child = spawn(spawnBin, spawnArgs, {
    cwd: cwd || process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });

  let buffer = "";
  let finalAssistantText = null;
  let sawAssistantStop = false;

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (!event || typeof event !== "object") continue;

      switch (event.type) {
        case "tool_execution_start":
          out(`  ${describeTool(event.toolName, event.args)}`);
          break;
        case "tool_execution_end": {
          const status = event.isError ? "\u2717" : "\u2713";
          out(`  ${status} ${event.toolName || "tool"}`);
          break;
        }
        case "message_end": {
          const msg = event.message;
          if (msg && msg.role === "assistant") {
            const text = messageText(msg);
            if (text.trim()) out(`  \u25aa ${text.replace(/\n/g, "\n     ").slice(0, 1000)}`);
            if (msg.stopReason === "stop") {
              finalAssistantText = text;
              sawAssistantStop = true;
            }
          }
          break;
        }
        default:
          break;
      }
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    // Surface startup/model errors so they're visible in the pane.
    const text = chunk.toString();
    if (text && !/pi-web-access|Dynamic tool activation/.test(text)) {
      out(`  ! ${text.trim().slice(0, 300)}`);
    }
  });

  let exitCode = 0;
  await new Promise((resolve) => child.on("close", (code) => { exitCode = code ?? 0; resolve(); }));

  // --- Extract the result ---------------------------------------------------
  // Prefer the last assistant message that ended with stopReason "stop".
  let result;
  const sourceText = finalAssistantText || extractLastAssistantText(buffer);
  const parsed = parseResult(sourceText);

  if (parsed) {
    result = { ok: true, result: parsed, exitCode };
  } else if (sourceText && sawAssistantStop) {
    result = { ok: false, error: "agent gave no parseable JSON result", text: sourceText.slice(0, 2000), exitCode };
  } else if (exitCode !== 0) {
    result = { ok: false, error: `pi exited with code ${exitCode}`, exitCode };
  } else {
    result = { ok: false, error: "pi produced no final assistant message", exitCode };
  }

  writeFileSync(join(runDir, "iter-result.json"), JSON.stringify(result, null, 2));

  // --- Visible summary banner ----------------------------------------------
  const bar = "\u2550".repeat(60);
  if (result.ok && result.result) {
    const r = result.result;
    out("");
    out(bar);
    out(`  RESULT: ${r.success ? "SUCCESS" : "FAILURE"}`);
    if (r.summary) out(`  Summary: ${r.summary}`);
    if (Array.isArray(r.key_changes_made) && r.key_changes_made.length) {
      out("  Changes:");
      r.key_changes_made.forEach((c) => out(`    - ${c}`));
    }
    if (Array.isArray(r.key_learnings) && r.key_learnings.length) {
      out("  Learnings:");
      r.key_learnings.forEach((l) => out(`    - ${l}`));
    }
    out(`  Should stop: ${r.should_stop ? "yes" : "no"}`);
    out(bar);
    out("");
  } else {
    out("");
    out(bar);
    out("  RESULT: ERROR");
    if (result.error) out(`  Error: ${String(result.error).slice(0, 300)}`);
    out(bar);
    out("");
  }

  process.exit(result.ok ? 0 : 1);
}

/** Parse a JSON result object from text, tolerating prose and fences. */
function parseResult(text) {
  if (!text) return null;
  const trimmed = String(text).trim();
  // Direct object
  if (trimmed.startsWith("{")) {
    try { const o = JSON.parse(trimmed); if (o && typeof o === "object" && "success" in o) return o; } catch {}
  }
  // Last balanced {...} block containing "success"
  let idx = trimmed.lastIndexOf('"success"');
  while (idx >= 0) {
    const start = trimmed.lastIndexOf("{", idx);
    if (start < 0) break;
    let depth = 0, end = -1, inStr = false, esc = false;
    for (let i = start; i < trimmed.length; i++) {
      const c = trimmed[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
      } else {
        if (c === '"') inStr = true;
        else if (c === "{") depth++;
        else if (c === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
      }
    }
    if (end > 0) {
      try { const o = JSON.parse(trimmed.slice(start, end)); if (o && "success" in o) return o; } catch {}
    }
    idx = trimmed.lastIndexOf('"success"', start - 1);
  }
  return null;
}

/** Fallback: scan raw JSONL for the last assistant message text. */
function extractLastAssistantText(raw) {
  let last = null;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e?.type === "message_end" && e.message?.role === "assistant") {
      const t = messageText(e.message);
      if (t.trim()) last = t;
    }
  }
  return last;
}

main().catch((error) => {
  try {
    writeFileSync(
      join(process.env.FA_RUN_DIR || process.cwd(), "iter-result.json"),
      JSON.stringify({ ok: false, error: error.message, exitCode: -1 }, null, 2),
    );
  } catch {}
  out("");
  out("\u2550".repeat(60));
  out("  RESULT: FATAL ERROR");
  out(`  ${error.message}`);
  out("\u2550".repeat(60));
  process.exit(1);
});
