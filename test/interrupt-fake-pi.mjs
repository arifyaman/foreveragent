// Synthetic slow fake pi for the tabs interrupt tests.
// Writes partial_work.txt immediately (simulating partial work), then
// sleeps FA_TEST_DELAY_MS before emitting a valid JSONL stream with a
// success result. Killed mid-sleep = the interrupt path.

import process from "node:process";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

mkdirSync(process.cwd(), { recursive: true });
writeFileSync(path.join(process.cwd(), "partial_work.txt"), "partial work\n");

const delay = Number(process.env.FA_TEST_DELAY_MS || 0);
setTimeout(() => {
  const text = JSON.stringify({
    success: true,
    summary: "iteration completed",
    key_changes_made: ["created partial_work.txt"],
    key_learnings: [],
    should_stop: false,
  });
  const message = {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "fake",
    provider: "a",
    model: "m1",
    usage: { input: 10, output: 5 },
    stopReason: "stop",
    responseId: "fake-1",
    timestamp: Date.now(),
  };
  process.stdout.write(JSON.stringify({ type: "turn_start" }) + "\n");
  process.stdout.write(JSON.stringify({ type: "message_end", message }) + "\n");
  process.stdout.write(JSON.stringify({ type: "turn_end", message, toolResults: [] }) + "\n");
  process.stdout.write(JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text }] }], willRetry: false }) + "\n");
  process.exit(0);
}, delay);
