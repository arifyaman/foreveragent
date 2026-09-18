// Configuration loading. Config file (foreveragent.json in the repo root by
// default) is optional; everything has a default. Models must come from
// config or the CLI.

export const DEFAULTS = {
  // Ordered model list. First entry is preferred; the rest are failover
  // targets. Strings or { model, thinking }.
  models: [],
  // Per-model default thinking level (string), overridable per model entry.
  thinking: undefined,
  maxIterations: 0, // 0 = unlimited
  maxConsecutiveFailures: 3,
  maxNoOps: 3,
  maxWallTimeMs: 0, // 0 = unlimited
  agentTimeoutMs: 30 * 60_000,
  failover: {
    cooldownMs: 5 * 60_000,
    backoffBaseMs: 5_000,
    backoffMaxMs: 15 * 60_000,
    rateLimitMaxWaitMs: 60 * 60_000,
  },
  piBin: "pi",
};

export function normalizeModels(models, defaultThinking) {
  const seen = new Set();
  const out = [];
  for (const entry of models) {
    const model = typeof entry === "string" ? entry.trim() : entry && typeof entry.model === "string" ? entry.model.trim() : "";
    if (!model) throw new Error("every model entry needs a non-empty model id");
    if (!/^[a-z0-9._-]+\/[a-z0-9._-]+$/i.test(model)) {
      throw new Error(`model id must be "provider/model": ${model}`);
    }
    if (seen.has(model)) continue;
    seen.add(model);
    out.push({
      model,
      thinking: typeof entry === "string" ? defaultThinking : entry.thinking ?? defaultThinking,
    });
  }
  if (out.length === 0) throw new Error("at least one model is required (config \"models\" or --models)");
  return out;
}

/**
 * Merge config file + CLI overrides into a run config.
 * @param fileConfig object loaded from foreveragent.json (or {})
 * @param overrides flat object of CLI-provided values (undefined = absent)
 */
export function resolveConfig(fileConfig = {}, overrides = {}) {
  const config = {
    ...DEFAULTS,
    ...pick(fileConfig, [
      "models",
      "thinking",
      "maxIterations",
      "maxConsecutiveFailures",
      "maxNoOps",
      "maxWallTimeMs",
      "agentTimeoutMs",
      "piBin",
    ]),
    failover: { ...DEFAULTS.failover, ...(fileConfig.failover || {}) },
  };
  if (overrides.models !== undefined) config.models = overrides.models;
  if (overrides.thinking !== undefined) config.thinking = overrides.thinking;
  for (const key of ["maxIterations", "maxConsecutiveFailures", "maxNoOps", "maxWallTimeMs", "agentTimeoutMs", "piBin"]) {
    if (overrides[key] !== undefined) config[key] = overrides[key];
  }
  if (overrides.failover) config.failover = { ...config.failover, ...overrides.failover };

  config.models = normalizeModels(config.models, config.thinking);
  return config;
}

function pick(object, keys) {
  const out = {};
  for (const key of keys) {
    if (object[key] !== undefined) out[key] = object[key];
  }
  return out;
}
