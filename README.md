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

## Getting started

### Requirements

- Node.js >= 20 and git.
- [pi](https://pi.dev) installed and logged in (`pi` interactive works, and
  `pi --list-models` shows at least two models you can use - the failover
  list is the point, so configure more than one provider).
- Optional: [herdr](https://herdr.dev) if you want runs in visible tabs.

### 1. Point it at a git repo

Any git repo with a clean tree and at least one initial commit. Drop a config
file at the repo root (or pass `--models` every time):

```sh
# foreveragent.json in the repo root
{
  "models": [
    "llama.cpp/Qwen3.8-27B-UD-IQ4_XS",   # cheap local model first
    "github-copilot/claude-sonnet-5",    # failover
    "opencode/gpt-5.4-mini"              # failover
  ],
  "thinking": "low",
  "agentTimeoutMs": 1800000
}
```

The order is the failover order. Anything the first model can do cheaply gets
done by it; when it rate-limits or errors, the next model takes over the same
iteration automatically.

### 2. Do a dry run first

```sh
cd your-repo
node /path/to/foreverAgent/bin/foreveragent.mjs "your objective here" --dry-run
```

This prints the resolved config (model list, caps) and the exact iteration 1
prompt without running anything. Fix whatever looks wrong before spending
tokens.

### 3. Small supervised run

Start with a bounded, verifiable objective and a small cap. Watch it:

```sh
node /path/to/foreverAgent/bin/foreveragent.mjs \
  "Add a unit test for the bug where addTask('') crashes, then fix the bug" \
  --max-iterations 3 --agent-timeout 10m
```

Expected shape of each iteration on the terminal:

```
--- iteration 2 ---
  model: github-copilot/claude-sonnet-5 (thinking: low)
  ok: fixed empty-title crash in store.mjs, added 3 regression tests. (commit 2)
```

Line meanings:

| Line prefix | Meaning |
| ----------- | ------- |
| `  ok: ... (commit N)` | iteration succeeded and was committed |
| `  failed: ... (N consecutive)` | agent reported failure; work rolled back |
| `  no-op: no file changes (N in a row)` | success but nothing changed; too many stalls the run |
| `  ! <model>: <kind> - <message>` | model error; next model in the list is tried for the same iteration |
| `  waiting <dur> before next model attempt` | honoring a rate-limit reset time |
| `  ! commit failed: ...` | rare; work kept uncommitted for the next iteration to repair |

### 4. The overnight pattern

Two ingredients make a good overnight run:

1. **A checklist objective.** A `ROADMAP.md` with small, verifiable items and
   a definition of done. Tell the agent to work through it one item at a time.
2. **A `--stop-when` condition** the agent can truthfully check each
   iteration, e.g. `"all roadmap items checked and npm test passes"`.

Inside a herdr workspace, start it in a visible tab:

```sh
foreveragent spawn "Work through ROADMAP.md in order, one item per iteration, checking each off only after its verification passes." \
  --stop-when "Every item in ROADMAP.md is checked and npm test passes" \
  --max-iterations 20 --max-wall-time 8h
```

`spawn` creates the tab, returns its id, and the run is visible under
`herdr tab focus <tabId>`. On Linux the run re-execs itself under
`systemd-inhibit` so the machine does not sleep (disable with
`--prevent-sleep off`).

Real-world reference: the demo run that built this project's sibling repo
(`/home/xlip/work/xlip/foreverAgent-demo`, a task CLI) finished all 10 roadmap
items in 10 iterations, 10 commits, 0 failures, ~19 minutes, local model
only - failover never even fired.

### 5. Read the results

```sh
git log --oneline        # one reviewable commit per iteration
git show <sha>           # what that iteration actually changed

foreveragent status      # live/latest run state (JSON)
foreveragent logs -n 50  # last 50 run.log events
```

Run data lives in `.foreveragent/runs/<runId>/`:

| File                    | What it is                                              |
| ----------------------- | ------------------------------------------------------- |
| `run.log`               | JSONL event log: iterations, model state changes, waits, stop reason |
| `state.json`            | live pid + counters (used by `status`/`stop`)           |
| `prompt.md`             | the exact iteration 1 prompt                            |
| `notes.md`              | shared memory: what the agent told past iterations      |
| `iteration-N-attempt-M.jsonl` | raw pi output stream for that attempt (debug goldmine) |

The final terminal summary (also `foreveragent status` after the run) gives
the stop reason, iteration/commit/failure counts, per-model state, and total
work. A `model_cooldown` / `model_dead` / `failover_wait` event in `run.log`
tells you exactly when and why a model was swapped.

### Troubleshooting

| Symptom | What it means / do |
| ------- | ------------------- |
| `working tree is not clean` | commit or stash first, or `--allow-dirty` (then the first commit may include your dirty files) |
| `no usable models` | `pi --list-models` - check login (copilot) or local server (llama.cpp) |
| run stops with `all_models_dead` | every model hit an unrecoverable error (auth/credits/unknown model). Fix the provider, re-run - iterations already committed are kept |
| run stops with `stalled` | agent made no file changes N times in a row. Usually the objective is too vague or the model too weak; sharpen it, or put a stronger model earlier in the list |
| run stops with `consecutive_failures` | iterations keep failing their verification. Look at the summaries in `run.log`; often the objective asks for more than one small step per iteration |
| model rate-limited all night | check `failover_wait` events; raise `failover.rateLimitMaxWaitMs` or add another provider to the list |
| you want to stop it | `foreveragent stop` (SIGINT; current iteration is killed, committed work is kept, stop reason `interrupted`) |
| agent committed junk (pyc files, caches) | build/test artifact paths are auto-excluded via `.git/info/exclude`; for anything else, add it to the repo's `.gitignore` |

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
