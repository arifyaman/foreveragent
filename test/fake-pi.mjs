#!/usr/bin/env node
// A fake pi for tests. Emulates the pi -p --mode json protocol (JSONL events,
// prompt on stdin) and behaves according to a scenario file (FA_SCENARIO).
//
// Scenario format (JSON):
// {
//   "models": {
//     "providerA/modelA": {
//       "iterations": [
//         { "iteration": 1, "exit": 1, "stderr": "Error: 429 ..." },
//         { "iteration": 2, "exit": 0, "text": "...", "files": {"a.txt": "content {iteration}"} }
//       ],
//       "default": { "exit": 0, "text": "{\"success\": true, ...}" }
//     }
//   }
// }
//
// Entry fields:
//   exit        process exit code (default 0)
//   stderr      text written to stderr (error lines)
//   text        final assistant text (exit 0 path)
//   stopReason  assistant stopReason (default "stop")
//   errorMessage assistant errorMessage (implied stopReason "error")
//   files       { path: content } written to cwd; "{iteration}" is replaced
//   delayMs     artificial delay before responding
//   usage       { input, output } fake usage numbers

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

async function readStdin() {
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

function parseModel(argv) {
  const index = argv.indexOf("--model");
  if (index >= 0 && argv[index + 1]) return argv[index + 1];
  return "unknown/model";
}

function pickBehavior(scenario, model, iteration) {
  const spec = scenario.models?.[model];
  if (!spec) {
    // Unknown model behaves like "model not found" (pi's own error).
    return { exit: 1, stderr: `Error: Model "${model}" not found. Use --list-models to see available models.` };
  }
  let behavior = null;
  for (const entry of spec.iterations || []) {
    if (entry.iteration === iteration) behavior = entry;
  }
  return behavior || spec.default || { exit: 0, text: '{"success": true, "summary": "default success", "key_changes_made": [], "key_learnings": [], "should_stop": false}' };
}

function render(text, iteration) {
  return String(text).replaceAll("{iteration}", String(iteration));
}

async function main() {
  const prompt = await readStdin();
  const model = parseModel(process.argv.slice(2));
  const match = prompt.match(/This is iteration (\d+)/);
  const iteration = match ? Number.parseInt(match[1], 10) : 1;

  let scenario = {};
  try {
    const { readFile } = await import("node:fs/promises");
    scenario = JSON.parse(await readFile(process.env.FA_SCENARIO, "utf8"));
  } catch {
    scenario = {};
  }

  const behavior = pickBehavior(scenario, model, iteration);
  if (behavior.delayMs) await new Promise((resolve) => setTimeout(resolve, behavior.delayMs));

  // Error-only entries (like pi's startup errors): no JSONL stream at all.
  if (behavior.exit !== 0 && !behavior.text && !behavior.stopReason && !behavior.errorMessage) {
    if (behavior.stderr) process.stderr.write(behavior.stderr + "\n");
    process.exit(behavior.exit);
  }

  const text = behavior.text ? render(behavior.text, iteration) : "";
  for (const [rel, content] of Object.entries(behavior.files || {})) {
    const target = path.join(process.cwd(), rel);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, render(content, iteration), "utf8");
  }

  const usage = behavior.usage || { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150 };
  const stopReason = behavior.errorMessage ? "error" : behavior.stopReason || (behavior.exit !== 0 ? "error" : "stop");
  const assistantMessage = {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "fake",
    provider: model.split("/")[0],
    model: model.split("/")[1],
    usage,
    stopReason,
    timestamp: Date.now(),
    responseId: `fake-${iteration}`,
  };
  if (behavior.errorMessage) assistantMessage.errorMessage = behavior.errorMessage;

  const lines = [
    { type: "session", version: 3, id: "fake-session", timestamp: new Date().toISOString(), cwd: process.cwd() },
    { type: "agent_start" },
    { type: "turn_start" },
    { type: "message_start", message: { role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() } },
    { type: "message_end", message: { role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() } },
    { type: "message_start", message: { ...assistantMessage, stopReason: "pending" } },
    { type: "message_end", message: assistantMessage },
    { type: "turn_end", message: assistantMessage, toolResults: [] },
    { type: "agent_end", messages: [{ role: "user", content: [{ type: "text", text: prompt }] }, assistantMessage], willRetry: false },
    { type: "agent_settled" },
  ];
  process.stdout.write(lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  if (behavior.stderr) process.stderr.write(behavior.stderr + "\n");
  process.exit(behavior.exit ?? 0);
}

main().catch((error) => {
  process.stderr.write(`fake-pi error: ${error.message}\n`);
  process.exit(1);
});
