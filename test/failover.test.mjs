// Unit tests: model error classification and the failover state machine.

import test from "node:test";
import assert from "node:assert/strict";
import { classifyModelError, parseWaitHint, Failover } from "../src/failover.mjs";

test("classifies rate limits", () => {
  assert.equal(classifyModelError("HTTP 429 Too Many Requests").kind, "rate_limit");
  assert.equal(classifyModelError("rate limit exceeded for this project").kind, "rate_limit");
  assert.equal(classifyModelError("The server is overloaded, please try again later").kind, "rate_limit");
  assert.equal(classifyModelError("529 overloaded").kind, "rate_limit");
});

test("classifies credit exhaustion as dead", () => {
  assert.equal(classifyModelError("insufficient credits to complete this request").kind, "credits");
  assert.equal(classifyModelError("payment required").kind, "credits");
});

test("classifies auth errors", () => {
  assert.equal(classifyModelError("401 unauthorized: invalid api key").kind, "auth");
  assert.equal(classifyModelError("Forbidden: token expired").kind, "auth");
  assert.equal(classifyModelError("login expired, please authenticate").kind, "auth");
});

test("classifies model not found", () => {
  assert.equal(classifyModelError('Model "x/y" not found. Use --list-models.').kind, "not_found");
  assert.equal(classifyModelError("404 model does not exist").kind, "not_found");
});

test("classifies context overflow", () => {
  assert.equal(classifyModelError("context length exceeded: 210000 > 200000").kind, "context");
  assert.equal(classifyModelError("prompt is too long: maximum context is 128k tokens").kind, "context");
});

test("classifies server and network errors", () => {
  assert.equal(classifyModelError("503 service unavailable").kind, "server");
  assert.equal(classifyModelError("internal server error").kind, "server");
  assert.equal(classifyModelError("fetch failed: ECONNREFUSED 127.0.0.1:8080").kind, "network");
  assert.equal(classifyModelError("socket hang up").kind, "network");
});

test("does not over-classify normal failure text", () => {
  assert.equal(classifyModelError("the tests failed because of a logic bug").kind, "none");
  assert.equal(classifyModelError("I could not make progress on this task").kind, "none");
});

test("parses wait hints", () => {
  assert.equal(parseWaitHint("retry in 45s"), 45_000);
  assert.equal(parseWaitHint("please try again in 10 minutes"), 600_000);
  assert.equal(parseWaitHint("rate limit resets in 2h", 24 * 3_600_000), 7_200_000);
  // default cap is 60 minutes
  assert.equal(parseWaitHint("rate limit resets in 2h"), 6_000_000);
  assert.equal(parseWaitHint("no hint here"), 0);
});

test("caps wait hints at maxWaitMs", () => {
  assert.equal(parseWaitHint("retry in 1000 hours", 60_000), 60_000);
});

const MODELS = [
  { model: "a/one" },
  { model: "b/two" },
  { model: "c/three" },
];
const FAST = { cooldownMs: 60_000, backoffBaseMs: 50, backoffMaxMs: 1000, rateLimitMaxWaitMs: 600_000 };

test("rotates to the next model on error", () => {
  const f = new Failover(MODELS, FAST);
  const decision = f.fail("a/one", "server");
  assert.equal(decision.model.model, "b/two");
  assert.equal(f.current().model, "b/two");
});

test("skips models in cooldown and waits when all are cooling down", () => {
  const f = new Failover(MODELS, FAST);
  f.fail("a/one", "server"); // a cooling
  f.fail("b/two", "server"); // b cooling (current now b)
  const decision = f.fail("c/three", "server"); // all cooling
  assert.ok(decision.waitMs > 0, "asks to wait");
  assert.equal(decision.abort, undefined);
});

test("marks not_found and auth models dead", () => {
  const f = new Failover(MODELS, FAST);
  f.fail("a/one", "not_found");
  assert.equal(f.stateOf("a/one").status, "dead");
  assert.equal(f.stateOf("b/two").status, "ok");
});

test("aborts when all models are dead", () => {
  const f = new Failover(MODELS, FAST);
  f.fail("a/one", "not_found");
  f.fail("b/two", "auth");
  const decision = f.fail("c/three", "credits");
  assert.equal(decision.abort, true);
  assert.equal(f.allDead(), true);
});

test("success resets sticky model and error counters", () => {
  const f = new Failover(MODELS, FAST);
  f.fail("a/one", "server");
  f.succeed("b/two");
  assert.equal(f.current().model, "b/two");
  assert.equal(f.hardErrors, 0);
  assert.equal(f.consecutiveErrors, 0);
  assert.equal(f.stateOf("b/two").status, "ok");
});

test("rate-limit waits respect the parsed wait time", () => {
  const f = new Failover(MODELS, FAST);
  const stateBefore = Date.now();
  f.fail("a/one", "rate_limit", 5_000);
  const state = f.stateOf("a/one");
  assert.equal(state.status, "cooldown");
  const waited = state.until - stateBefore;
  assert.ok(waited >= 4_900 && waited <= 5_200, `waited ${waited}ms`);
});

test("rate-limit waits are capped by rateLimitMaxWaitMs", () => {
  const f = new Failover(MODELS, { ...FAST, rateLimitMaxWaitMs: 1_000 });
  f.fail("a/one", "rate_limit", 5_000);
  const state = f.stateOf("a/one");
  const waited = state.until - Date.now();
  assert.ok(waited <= 1_100, `capped to ~1s, got ${waited}ms`);
});

test("hardErrors accumulates for non-rate-limit kinds only", () => {
  const f = new Failover(MODELS, FAST);
  f.fail("a/one", "rate_limit");
  assert.equal(f.hardErrors, 0);
  f.fail("a/one", "server");
  assert.equal(f.hardErrors, 1);
  f.fail("b/two", "network");
  assert.equal(f.hardErrors, 2);
});

test("wraps around to the first model after the last fails", () => {
  const f = new Failover(MODELS, FAST);
  f.currentIndex = 2; // on c/three
  const decision = f.fail("c/three", "server");
  assert.equal(decision.model.model, "a/one");
});
