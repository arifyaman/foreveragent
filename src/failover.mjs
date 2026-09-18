// Model error classification and model failover state machine.
//
// Goal: when the current model/provider errors (rate limit, auth, 5xx,
// network, context overflow, dead model, unparseable output), switch to the
// next available model and retry the same iteration. Models that are broken
// for the whole run (dead) or temporarily broken (cooldown) are tracked so
// the loop can wait instead of hammering a broken endpoint.

export const MODEL_ERROR_KINDS = [
  "none",
  "rate_limit",
  "credits",
  "auth",
  "server",
  "network",
  "timeout",
  "context",
  "not_found",
  "format",
  "unknown",
];

// Ordered pattern rules. First match wins, so specific (credits, context,
// not_found, auth) come before generic (rate_limit, server, network).
const RULES = [
  {
    kind: "credits",
    test: /insufficient (credits|funds|balance|quota)|credit (balance|limit)|out of credits|exhausted (credits|quota)|billing|payment required|402\b/i,
  },
  {
    kind: "context",
    test: /context length|too many tokens|maximum context|prompt is too long|context (window )?exceeded|reduce the length|too long for (the )?(context|model)/i,
  },
  {
    kind: "not_found",
    test: /model .{0,60} not found|no such model|unknown model|model id .* (does not exist|invalid)|cannot find module|404\b/i,
  },
  {
    kind: "auth",
    test: /unauthorized|401\b|forbidden|403\b|api key|invalid (api )?(key|token|credential)|credential|login (required|expired)|authentication|permission denied/i,
  },
  {
    kind: "rate_limit",
    test: /rate.?limit|429\b|too many requests|usage limit|quota (exceeded|reached)|exceeded your|limit reached|overloaded|529\b|server is (at capacity|busy)/i,
  },
  {
    kind: "server",
    test: /\b5\d\d\b|internal server error|bad gateway|service unavailable|gateway timeout|temporarily unavailable|system busy/i,
  },
  {
    kind: "network",
    test: /ECONNREFUSED|ECONNRESET|EPIPE|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|network (error|unreachable)|connection (refused|reset|closed|aborted|timed out)/i,
  },
];

/**
 * Classify an error text (stderr + assistant errorMessage combined).
 *
 * Returns { kind, waitMs }. kind is one of MODEL_ERROR_KINDS ("none" when the
 * text does not look like a model error). waitMs is a suggested wait parsed
 * from the message (rate-limit retry hints), capped by maxWaitMs.
 */
export function classifyModelError(text, maxWaitMs = 6_000_000) {
  if (typeof text !== "string" || text.trim().length === 0) {
    return { kind: "none", waitMs: 0 };
  }
  for (const rule of RULES) {
    if (rule.test.test(text)) {
      return { kind: rule.kind, waitMs: parseWaitHint(text, maxWaitMs) };
    }
  }
  return { kind: "none", waitMs: 0 };
}

/**
 * Pull a wait hint out of an error message, e.g. "retry in 45s",
 * "rate limit resets in 10 minutes", "try again after 2026-09-19T05:00:00Z".
 */
export function parseWaitHint(text, maxWaitMs = 6_000_000) {
  const ms = 1000;
  const min = 60_000;
  const hour = 3_600_000;

  const relative =
    text.match(/(?:try again|retry|re-?try|wa?it)\s*(?:in|after)\s*(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|seconds|m|min|mins|minutes|h|hr|hour|hours)?/i) ||
    text.match(/resets?\s+(?:in|after)\s*(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|seconds|m|min|mins|minutes|h|hr|hour|hours)?/i) ||
    text.match(/(?:available|unavailable) in (\d+(?:\.\d+)?)\s*(ms|s|sec|secs|seconds|m|min|mins|minutes|h|hr|hour|hours)?/i);
  if (relative) {
    const value = Number.parseFloat(relative[1]);
    const unit = (relative[2] || "s").toLowerCase();
    let waitMs;
    if (unit.startsWith("h")) waitMs = value * hour;
    else if (unit.startsWith("m") && !unit.startsWith("ms")) waitMs = value * min;
    else if (unit.startsWith("ms")) waitMs = value;
    else waitMs = value * ms;
    if (Number.isFinite(waitMs) && waitMs > 0) {
      return Math.min(waitMs, maxWaitMs);
    }
  }

  const iso = text.match(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/);
  if (iso) {
    const until = Date.parse(iso[0]);
    if (Number.isFinite(until)) {
      const waitMs = until - Date.now();
      if (waitMs > 0) return Math.min(waitMs, maxWaitMs);
    }
  }
  return 0;
}

/** Kinds that make a model unusable for the rest of the run. */
const DEAD_KINDS = new Set(["not_found", "auth", "credits"]);

export class Failover {
  /**
   * @param models array of { model: string, thinking?: string } (in priority
   *   order). The first entry is the preferred model.
   * @param opts { cooldownMs, backoffBaseMs, backoffMaxMs, rateLimitMaxWaitMs }
   */
  constructor(models, opts = {}) {
    if (!Array.isArray(models) || models.length === 0) {
      throw new Error("failover requires at least one model");
    }
    this.models = models.map((entry) =>
      typeof entry === "string" ? { model: entry, thinking: undefined } : { model: entry.model, thinking: entry.thinking },
    );
    this.cooldownMs = opts.cooldownMs ?? 5 * 60_000;
    this.backoffBaseMs = opts.backoffBaseMs ?? 5_000;
    this.backoffMaxMs = opts.backoffMaxMs ?? 15 * 60_000;
    this.rateLimitMaxWaitMs = opts.rateLimitMaxWaitMs ?? 60 * 60_000;
    this.states = new Map(this.models.map((m) => [m.model, { status: "ok", until: 0, reason: "", failures: 0 }]));
    this.currentIndex = 0;
    this.consecutiveErrors = 0;
    this.hardErrors = 0;
    this.events = [];
  }

  stateOf(model) {
    return this.states.get(model);
  }

  /**
   * Report a model error on `model` (already classified with
   * classifyModelError, or kind "timeout" / "format" from the orchestrator)
   * and return the next model to try, or { waitMs } when everything is in
   * cooldown, or { abort: true } when every model is dead.
   */
  fail(model, kind, waitMs = 0) {
    const state = this.states.get(model);
    const now = Date.now();
    const effectiveKind = kind === "timeout" || kind === "format" ? kind : kind;
    const effectiveWait =
      kind === "rate_limit"
        ? Math.min(waitMs > 0 ? waitMs : this.cooldownMs, this.rateLimitMaxWaitMs)
        : waitMs > 0
          ? Math.min(waitMs, this.rateLimitMaxWaitMs)
          : this.cooldownMs;

    state.failures += 1;
    this.consecutiveErrors += 1;
    if (kind !== "rate_limit") this.hardErrors += 1;

    if (DEAD_KINDS.has(effectiveKind)) {
      state.status = "dead";
      state.reason = effectiveKind;
      this.events.push({ type: "model_dead", model, kind: effectiveKind });
    } else {
      state.status = "cooldown";
      state.until = now + Math.max(effectiveWait, 1000);
      state.reason = effectiveKind;
      this.events.push({ type: "model_cooldown", model, kind: effectiveKind, waitMs: state.until - now });
    }

    return this.next();
  }

  /**
   * Report success on `model`. Resets the model's failure state (it stays
   * sticky: the loop keeps using it) and clears the error backoff.
   */
  succeed(model) {
    const state = this.states.get(model);
    if (state) {
      state.status = "ok";
      state.until = 0;
      state.reason = "";
    }
    this.consecutiveErrors = 0;
    this.hardErrors = 0;
    this.currentIndex = this.models.findIndex((m) => m.model === model);
    if (this.currentIndex < 0) this.currentIndex = 0;
  }

  current() {
    return this.models[this.currentIndex];
  }

  /**
   * Pick the next model after the current one wrapped around, skipping dead
   * and cooling-down models. Returns:
   *   { model }              - next model to try (currentIndex updated)
   *   { waitMs }             - no model available; wait until at least this long
   *   { abort: true }        - every model is dead
   */
  next() {
    const now = Date.now();
    const n = this.models.length;
    for (let step = 1; step <= n; step += 1) {
      const index = (this.currentIndex + step) % n;
      const state = this.states.get(this.models[index].model);
      if (state.status === "dead") continue;
      if (state.status === "cooldown" && state.until <= now) {
        state.status = "ok";
        state.until = 0;
      }
      if (state.status === "ok") {
        this.currentIndex = index;
        return { model: this.models[index] };
      }
    }
    if (this.allDead()) return { abort: true };

    const earliest = Math.min(
      ...[...this.states.values()]
        .filter((state) => state.status === "cooldown")
        .map((state) => state.until),
    );
    const backoff = Math.min(
      this.backoffBaseMs * 2 ** Math.min(this.consecutiveErrors, 8),
      this.backoffMaxMs,
    );
    const waitUntil = Math.min(earliest, now + backoff);
    return { waitMs: Math.max(waitUntil - now, 1000) };
  }

  allDead() {
    return [...this.states.values()].every((state) => state.status === "dead");
  }

  summary() {
    return this.models.map((m) => ({
      model: m.model,
      state: this.states.get(m.model).status,
      failures: this.states.get(m.model).failures,
    }));
  }
}
