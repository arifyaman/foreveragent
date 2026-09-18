# foreveragent

A minimal autonomous agent loop, in the spirit of
[gnhf](https://github.com/kunchenguid/gnhf) ("good night, have fun") but
deliberately small: one dependency-free Node.js program that keeps a coding
agent working on an objective until a stopping point is reached, and at each
point does the boring work for it - committing successes, rolling back
failures, switching to another model when the current one errors.

```
foreveragent "improve the test coverage of src/" --max-iterations 20
# go to sleep
```

You wake up to a branch with one small committed step per iteration, a log of
everything that happened, and (hopefully) the objective done.

## How it works

Each iteration:

1. The orchestrator builds a prompt: the objective, a pointer to `notes.md`
   (a shared memory file it appends to after every iteration), and a strict
   output contract (one JSON object: `success`, `summary`,
   `key_changes_made`, `key_learnings`, `should_stop`).
2. It runs `pi` non-interactively (`pi -p --mode json --no-session --approve
   --model <provider/model>`) in the repo, with the prompt on stdin and the
   JSONL stream teed to `iteration-N-attempt-M.jsonl`.
3. On a successful iteration with file changes, it commits them
   (`foreveragent <n>: <summary>`). On a reported failure it rolls the tree
   back (`git reset --hard` + `git clean -fd`) and moves on.
4. On a **model error** (rate limit, 5xx, network, auth, dead model, context
   overflow, agent timeout, or an output without any parseable JSON) it rolls
   back partial work and **fails over to the next model** in the configured
   list, retrying the same iteration. Models are tracked: `cooldown`
   (temporarily broken) or `dead` (broken for the whole run), with wait hints
   parsed from rate-limit messages. A success makes the model sticky.

Stopping points ("run until some points do somethings"):

| Reason                 | What happens                                                        |
| ---------------------- | ------------------------------------------------------------------- |
| `done`                | agent set `should_stop: true` (objective met); last work committed  |
| `stop_condition`      | agent reported the `--stop-when` condition as fully met             |
| `max_iterations`      | reached `--max-iterations`                                          |
| `max_wall_time`       | reached `--max-wall-time`                                           |
| `stalled`             | `--max-no-ops` consecutive iterations without file changes (default 3) |
| `consecutive_failures`| `--max-consecutive-failures` failed iterations in a row (default 3) |
| `all_models_dead`     | every model in the list is dead for this run                        |
| `agent_errors_exhausted` | too many unexplained agent errors across all models            |
| `interrupted`         | SIGINT/SIGTERM (current agent call is killed, committed work kept)  |

Run state lives in `.foreveragent/runs/<runId>/` (excluded from git locally
via `.git/info/exclude`, so the tree stays clean): `run.log` (JSONL),
`notes.md`, `prompt.md`, `state.json` (live pid/status for `stop`), and the
raw per-attempt agent streams.

## Usage

```sh
# From inside a git repo with a clean tree and at least one commit:
node bin/foreveragent.mjs "<objective>" [options]
# or, after `npm link` (or PATH install):
foreveragent "<objective>" [options]
```

### Options

| Option                       | Meaning                                                          | Default |
| ---------------------------- | ---------------------------------------------------------------- | ------- |
| `--models <a,b\|a b ...>`    | ordered model list (`provider/model`); failover order (greedy: all following non-flag args) | config |
| `--model <provider/model>`   | single model (overrides `--models`)                              |         |
| `--thinking <level>`         | pi thinking level (off/minimal/low/medium/high)                  | config |
| `--config <path>`            | config file (default `foreveragent.json` in the repo root)        |         |
| `--max-iterations <n>`       | stop after n iterations (0 = unlimited)                          | 0 |
| `--max-consecutive-failures <n>` | stop after n consecutive failed iterations                   | 3 |
| `--max-no-ops <n>`           | stop after n consecutive no-op iterations                        | 3 |
| `--max-wall-time <dur>`      | stop after a wall-time cap (`8h`, `45m`, `90s`)                  | 0 |
| `--agent-timeout <dur>`      | per-iteration agent timeout (a timeout is a model error)          | 30m |
| `--stop-when <condition>`    | end when the agent reports this condition is met                  | - |
| `--branch <name>`            | create and switch to a new branch before starting                 | current |
| `--allow-dirty`              | start even with uncommitted changes                               | off |
| `--prevent-sleep <on|off>`   | prevent system sleep via systemd-inhibit (Linux, re-execs self) | on  |
| `--pi-bin <path>`            | agent binary (any pi-compatible CLI; `.js/.mjs` scripts run via node) | `pi` |
| `--dry-run`                  | print resolved config + iteration 1 prompt, exit                 | - |
| `--json`                     | print the final state as JSON on stdout                          | - |

Durations accept `ms`, `s`, `m`, `h` (`300` means 300 seconds; write `300ms`
for milliseconds).

### Config file (`foreveragent.json`)

```json
{
  "models": [
    { "model": "llama.cpp/Qwen3.8-27B-UD-IQ4_XS", "thinking": "low" },
    { "model": "github-copilot/claude-sonnet-5", "thinking": "low" },
    { "model": "opencode/gpt-5.4-mini", "thinking": "low" }
  ],
  "thinking": "low",
  "maxIterations": 0,
  "maxConsecutiveFailures": 3,
  "maxNoOps": 3,
  "maxWallTimeMs": 0,
  "agentTimeoutMs": 1800000,
  "failover": {
    "cooldownMs": 300000,
    "backoffBaseMs": 5000,
    "backoffMaxMs": 900000,
    "rateLimitMaxWaitMs": 3600000
  },
  "piBin": "pi"
}
```

`models` entries may be plain strings or objects with a per-model `thinking`
override. CLI flags override the config file.

### Model failover (the must-have)

Errors are classified from the agent's exit code, stderr, and the assistant
`errorMessage` field:

- `rate_limit` - waits out the reported reset time (capped by
  `rateLimitMaxWaitMs`) on that model, meanwhile trying the next models;
- `credits` / `auth` / `not_found` - the model is **dead** for the run
  (retrying cannot help);
- `server`, `network`, `context`, `timeout` - the model goes into cooldown
  (`cooldownMs`) and the next model is tried;
- `format` - the agent finished but emitted no parseable JSON result (a sign
  the model is too weak for the contract): short 60s cooldown, next model;
- unclassified non-zero exit - `unknown`: treated as a model error too, and
  if every model keeps failing unexplained (`4 x number_of_models` hard
  errors in a row) the run aborts with `agent_errors_exhausted` instead of
  spinning.

Every decision is a `model_cooldown` / `model_dead` / `agent_error` /
`failover_wait` event in `run.log`.

## Herdr integration

Designed to run inside a [herdr](https://herdr.dev) tab next to your other
agent sessions. Subcommands (run from the repo):

```sh
# start a run in a NEW herdr tab of your current workspace (visible, focusable):
foreveragent spawn "<objective>" --max-iterations 20 --stop-when "tests pass"

# watch / manage:
foreveragent status          # latest run state (or: status <run-id>)
foreveragent logs -n 50      # tail the run log
foreveragent stop            # SIGINT the live run (clean stop after current call)

# in herdr: herdr tab focus <tabId> to watch the run's terminal
```

`spawn` is only available inside a herdr workspace (`HERDR_WORKSPACE_ID`);
outside herdr, run the plain command directly.

## Tests

Zero-dependency, `node:test` only:

```sh
npm test
```

- `test/jsonx.test.mjs` - result extraction (fences, prose, last-object, coercion)
- `test/failover.test.mjs` - error classification + failover state machine
- `test/git.test.mjs` - git helpers
- `test/e2e.test.mjs` - full orchestrator runs against a fake pi
  (`test/fake-pi.mjs` emulates the pi JSONL protocol, including model errors,
  failover, rollbacks, no-ops, timeouts, and stop conditions)

## Design notes (why it looks the way it does)

- **Zero dependencies, no build step.** `node bin/foreveragent.mjs` is the
  whole deployment. Long-running unattended code should be trivially
  inspectable.
- **pi as the agent, model via flag.** All failover is expressed as "run the
  same iteration with `--model <other>`", so adding a provider is a config
  line, not code.
- **Commit on success, roll back on failure** - the same contract as gnhf:
  the branch is always in a valid state, every iteration is a reviewable
  commit, and nothing unverified ever survives.
- **Local-only exclusion.** Run data is hidden via `.git/info/exclude`
  (never `.gitignore`), so the clean-tree check stays true and the repo
  history contains only intentional work.
- **Plain-text logs.** `run.log` is JSONL, `state.json` is read by `stop` /
  `status`, and the terminal output is readable at 3am. No TUI, no network
  telemetry, nothing to update overnight.
