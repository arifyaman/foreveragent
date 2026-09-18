// Run logging: a JSONL orchestrator log plus human-readable console lines.
// Plain stdout lines on purpose - the run sits in a terminal (often a herdr
// tab), so nothing fancy, always safe to read after the fact.

import { mkdir } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import path from "node:path";

export class RunLog {
  /**
   * @param dir run directory (must exist or be creatable)
   * @param consoleFn prints to the terminal; default console.log
   */
  constructor(dir, consoleFn = console.log) {
    this.dir = dir;
    this.logPath = path.join(dir, "run.log");
    this.print = consoleFn;
  }

  /** Append a structured event to run.log and print a one-line summary.
   *  Synchronous on purpose: the run is long and the final events (run_end,
   *  state) must never be lost to an in-flight async write at exit. */
  event(type, data = {}, summary) {
    const record = {
      ts: new Date().toISOString(),
      type,
      ...data,
    };
    const line = JSON.stringify(record);
    try {
      appendFileSync(this.logPath, line + "\n");
    } catch {
      /* logging must never kill the run */
    }
    if (summary) this.print(summary);
    return record;
  }

  info(message) {
    this.print(message);
  }

  async ensureDir() {
    await mkdir(this.dir, { recursive: true });
  }
}

export function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function parseDuration(text) {
  if (typeof text === "number") return Number.isFinite(text) ? text * 1000 : 0;
  const match = String(text).trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|seconds|m|min|mins|minutes|h|hr|hour|hours)?$/i);
  if (!match) throw new Error(`invalid duration: ${text}`);
  const value = Number.parseFloat(match[1]);
  const unit = (match[2] || "s").toLowerCase();
  if (unit.startsWith("h")) return value * 3_600_000;
  if (unit.startsWith("m") && !unit.startsWith("ms")) return value * 60_000;
  if (unit.startsWith("ms")) return value;
  return value * 1000;
}
