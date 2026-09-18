// Unit tests: JSON result extraction.

import test from "node:test";
import assert from "node:assert/strict";
import { parseAgentResult, extractLastJsonObject, stripJsonFences } from "../src/jsonx.mjs";

const VALID = {
  success: true,
  summary: "did the thing",
  key_changes_made: ["changed a"],
  key_learnings: ["note b"],
  should_stop: false,
};

test("parses a bare JSON object", () => {
  const parsed = parseAgentResult(JSON.stringify(VALID));
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.result.success, true);
  assert.equal(parsed.result.summary, "did the thing");
  assert.deepEqual(parsed.result.keyChanges, ["changed a"]);
  assert.equal(parsed.result.shouldStop, false);
});

test("parses JSON wrapped in markdown fences with prose", () => {
  const text = "Sure! Here you go:\n\n```json\n" + JSON.stringify(VALID) + "\n```\n\nAll done.";
  const parsed = parseAgentResult(text);
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.result.success, true);
});

test("prefers the last balanced object", () => {
  const text =
    'First I tried {"success": false, "summary": "old attempt"} and then the real result:\n' +
    JSON.stringify(VALID);
  const parsed = parseAgentResult(text);
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.result.success, true);
  assert.equal(parsed.result.summary, "did the thing");
});

test("coerces string booleans", () => {
  const parsed = parseAgentResult('{"success": "true", "summary": "ok"}');
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.result.success, true);
});

test("accepts snake_case stop variants", () => {
  const parsed = parseAgentResult('{"success": true, "summary": "s", "should_fully_stop": true}');
  assert.equal(parsed.result.shouldStop, true);
});

test("single-string arrays become arrays", () => {
  const parsed = parseAgentResult('{"success": true, "summary": "s", "key_changes_made": "one change"}');
  assert.deepEqual(parsed.result.keyChanges, ["one change"]);
});

test("reports no_json for prose without a result", () => {
  const parsed = parseAgentResult("I worked on it and made some adjustments to the module.");
  assert.equal(parsed.error, "no_json");
});

test("treats explicit prose failure as a reported failure", () => {
  const parsed = parseAgentResult("I failed to implement this, could not get the tests to pass.");
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.result.success, false);
});

test("braces inside strings do not break extraction", () => {
  const text = '{"summary": "contains { and } braces", "success": true}';
  const parsed = parseAgentResult(text);
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.result.summary, "contains { and } braces");
});

test("escape sequences inside strings are handled", () => {
  const text = '{"summary": "quoted \\" brace { here", "success": true}';
  const parsed = parseAgentResult(text);
  assert.equal(parsed.error, undefined);
});

test("stripJsonFences removes optional language tag", () => {
  assert.equal(stripJsonFences("```json\n{}\n```"), "{}");
  assert.equal(stripJsonFences("```\n{}\n```"), "{}");
  assert.equal(stripJsonFences("plain"), "plain");
});

test("extractLastJsonObject returns null for nothing", () => {
  assert.equal(extractLastJsonObject("no objects here"), null);
});

test("single failing object at index 0 does not loop forever", () => {
  // Regression: lastIndexOf("{", -1) clamps to 0, which used to spin the
  // cursor forever when the only balanced object failed validation.
  const parsed = parseAgentResult('{"success": "yes", "summary": "ok"}');
  assert.equal(parsed.error, "no_json");
});
