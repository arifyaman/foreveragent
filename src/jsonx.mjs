// Extract and validate the agent's final JSON result from free text.
//
// Agents are instructed to end with a bare JSON object, but real models
// sometimes wrap it in fences or add prose. These helpers recover the
// structured payload without changing behaviour for the well-formed path.

export function stripJsonFences(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  const withoutOpen = trimmed.replace(/^```(?:json)?\s*\n?/, "");
  return withoutOpen.replace(/\n?```\s*$/, "").trim();
}

/**
 * Walk forward from `start` (which must be `{`) and return the substring of
 * the first balanced JSON object, or null. Tracks string state and escapes so
 * braces inside strings do not affect depth.
 */
export function tryExtractBalancedObject(text, start) {
  if (text[start] !== "{") return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        try {
          JSON.parse(candidate);
          return candidate;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Find a balanced JSON object in `text`, preferring the rightmost one (the
 * agent is supposed to end its message with the result). Returns a parsed
 * value or null.
 */
export function extractLastJsonObject(text, accepts) {
  let cursor = text.lastIndexOf("{");
  while (cursor >= 0) {
    const candidate = tryExtractBalancedObject(text, cursor);
    if (candidate !== null) {
      const parsed = JSON.parse(candidate);
      if (!accepts || accepts(parsed)) return parsed;
    }
    if (cursor === 0) break;
    // Note: lastIndexOf with a negative fromIndex clamps to 0, so the loop
    // must break explicitly at cursor 0.
    cursor = text.lastIndexOf("{", cursor - 1);
  }
  return null;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStringArray(value) {
  if (value === undefined || value === null) return [];
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? item.trim() : item == null ? "" : String(item)))
      .filter((item) => item.length > 0);
  }
  return [String(value)];
}

/**
 * Validate an agent result object.
 *
 * Shape: { success: boolean, summary: string,
 *          key_changes_made: string[], key_learnings: string[],
 *          should_stop?: boolean }
 *
 * Returns null when the value is not a usable result (e.g. it is not an
 * object, or `success` is not a boolean).
 */
export function validateAgentResult(value) {
  if (!isRecord(value)) return null;
  if (typeof value.success !== "boolean") return null;
  const shouldStop =
    value.should_fully_stop ?? value.should_stop ?? value.stop ?? false;
  return {
    success: value.success,
    summary: typeof value.summary === "string" ? value.summary.trim() : "",
    keyChanges: asStringArray(value.key_changes_made ?? value.keyChanges),
    keyLearnings: asStringArray(value.key_learnings ?? value.keyLearnings),
    shouldStop: shouldStop === true || shouldStop === "true",
  };
}

/**
 * Parse the final assistant text into an agent result.
 *
 * Returns { result } on success, or { error: "no_json" | "invalid" } when the
 * text contains no usable result object.
 */
export function parseAgentResult(text) {
  if (typeof text !== "string" || text.trim().length === 0) {
    return { error: "no_json" };
  }
  const cleaned = stripJsonFences(text);
  const validated = extractLastJsonObject(cleaned, (value) => {
    return validateAgentResult(value) !== null;
  });
  if (validated !== null) {
    return { result: validateAgentResult(validated) };
  }
  // Second pass: maybe the object is there but `success` is missing or the
  // type is off (e.g. "success": "true"). Coerce if possible.
  const fallback = extractLastJsonObject(cleaned);
  if (fallback !== null && isRecord(fallback)) {
    const coerced = {
      ...fallback,
      success:
        fallback.success === true ||
        fallback.success === "true"
          ? true
          : fallback.success === false || fallback.success === "false"
            ? false
            : undefined,
    };
    const result = validateAgentResult(coerced);
    if (result !== null) return { result };
  }
  // Last resort: no JSON at all. If the text explicitly declares failure
  // without ever using the word "success", honour it as a normal reported
  // failure so a weak model that cannot emit JSON still discards its work.
  // Otherwise the output is treated as an unparseable format error, which
  // the failover logic handles by trying another model.
  const failureSignal =
    /success\s*[:=]\s*false|(^|\s)failed\b|(^|\s)failure\b|could not|unable to|cannot complete/i;
  const mentionsSuccess = /\bsuccess\b/i.test(cleaned);
  if (failureSignal.test(cleaned) && !mentionsSuccess) {
    return {
      result: {
        success: false,
        summary: "agent finished without a JSON result; reported failure",
        keyChanges: [],
        keyLearnings: [],
        shouldStop: false,
      },
    };
  }
  return { error: "no_json" };
}
