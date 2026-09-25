# foreveragent tabs — Design Document

## Goal

Run each `foreveragent` iteration in its own persistent herdr tab with full Pi TUI output visible. Conversations persist across iterations via `notes.md`. Tabs never auto-close.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  foreveragent (tabs) — orchestrator tab                     │
│  - Manages tab lifecycle                                    │
│  - Tracks git state (commits/rollbacks)                     │
│  - Manages notes.md (conversation context)                  │
│  - Polls iter-result.json for completion                    │
│                                                             │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  Iteration 1 (new tab)                                  │ │
│  │  ├─ Runs: node tabs-child.mjs                           │ │
│  │  ├─ TUI output visible in tab                           │ │
│  │  └─ Writes: iter-result.json                            │ │
│  │                                                         │ │
│  │  ┌─────────────────────────────────────────────────────┐ │ │
│  │  │  Iteration 2 (new tab)                              │ │ │
│  │  │  └─ Same pattern                                     │ │ │
│  │  └─────────────────────────────────────────────────────┘ │ │
│  └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## Files

### `src/tabs.mjs` — Orchestrator

Entry point invoked from `bin/foreveragent.mjs`.

**Key flow:**

1. **Setup**
   - Load config from `foreveragent.json`
   - Read objective from CLI args
   - Create run dir: `.foreveragent/runs/<timestamp>/`
   - Create `prompt.md`, `notes.md`, `state.json`
   - Create orchestrator tab

2. **Orchestrator tab creation**
   - Check for existing idle tab (by pane list + scrollback read)
   - Reuse if found, otherwise create new tab
   - Tab label: `"foreveragent (tabs)"`

3. **Iteration loop**
   For each iteration (up to `--max-iterations`):
   - Determine model from config (with failover)
   - Build prompt: reads `notes.md`, prepends system prompt + objective
   - Create new iteration tab (never reuse)
   - Write `child-config.json` with: model, thinking, bin, runDir, prompt, cwd
   - Delete any stale `iter-result.json`, then run the child in the tab via `herdr pane run`
   - Poll `iter-result.json` for completion (every 2s, timeout from `--agent-timeout`)
   - Read result:
     - If `should_stop`: exit loop
     - If `ok`: log success, create commit, update `notes.md`
     - If `!ok`: log error, rollback if needed, update `notes.md`
   - Track consecutive failures/no-ops for stop conditions

4. **Cleanup**
   - Write final state
   - Log summary

**Key functions:**
- `createTab(workspaceId, cwd, label)` — creates tab + root pane
- `spawnIterationTab(workspaceId, cwd, label, childConfig)` — creates new tab + types child command
- `findReusableTab(workspaceId, cwd)` — finds idle pane with valid scrollback
- `appendNotes(runDir, text)` — appends to `notes.md`
- `extractText(message)` — extracts text from Pi message objects

### `src/tabs-child.mjs` — Iteration Worker

Runs in the iteration tab's pane (via `herdr pane run`, so its stdout is
shown live in the pane). Runs one `pi` invocation, renders each event as a
readable line, writes result.

**Flow:**

1. Read config from `<runDir>/child-config.json`
2. Spawn `pi -p --mode json --approve --model <model> --thinking <thinking> -- <prompt>`
   - The prompt is passed as a **positional argument after `--`** so it is never
     swallowed by option parsing (this was the original bug that caused hangs).
   - `--mode json` gives a structured JSONL event stream on stdout.
3. Parse the JSONL event stream line-by-line and **render readable lines to the
   child's own stdout** (which the pane displays):
   - `tool_execution_start` -> `→ read <path>`, `→ bash <cmd>`, ... (truncated)
   - `tool_execution_end`   -> `✓ <tool>` (or `✗ <tool>` on error)
   - assistant `message_end` -> `▪ <text>` (the agent's reasoning/answer)
4. Track the final assistant message (`stopReason === "stop"`) for the result.
5. On pi exit:
   - Parse the result JSON from the final assistant text (tolerates prose, fences,
     and pretty-printed JSON by locating the balanced `{...}` block containing `"success"`)
   - Write `<runDir>/iter-result.json` with: `{ ok, result, error, exitCode }`
   - Print a visible summary banner

**Summary banner format:**
```
════════════════════════════════════════════════════════════
  RESULT: SUCCESS/FAILURE
  Summary: <r.summary>
  Changes:
    - <key_changes_made[i]>
  Learnings:
    - <key_learnings[i]>
  Should stop: yes/no
════════════════════════════════════════════════════════════
```

### `bin/foreveragent.mjs` — CLI Router

Added `tabs` subcommand handler:
```js
if (command === 'tabs') {
  // parse args, pass to tabs.mjs
}
```

## Config

```json
{
  "models": [
    { "model": "llama.cpp/<model-name>", "thinking": "low" }
  ],
  "max_iterations": 10,
  "max_consecutive_failures": 3,
  "max_no_ops": 3,
  "agent_timeout": "5m"
}
```

## State Persistence

- **`notes.md`**: Markdown file shared across iterations. Updated each iteration with:
  - What was done
  - What failed
  - What to try next
  - Key learnings

- **`state.json`**: JSON state file with run metadata, model states, iteration count.

- **`iter-result.json`**: Written by each child process, read by orchestrator for completion detection.

## Herdr Integration

### Creating tabs
```
herdr tab create --workspace wZ --cwd <path> --label "<label>" --no-focus
```
Returns: `{ tab_id, root_pane_id }`

### Running in a pane
```
herdr pane run <paneId> <command>
```
Executes `<command>` in the pane's shell. Output stays visible in the pane.
Returns **immediately** (fire-and-forget) even for long-running commands, so the
orchestrator polls `iter-result.json` to detect completion. `herdr pane run` was
chosen over `pane send-keys` because it reliably delivers the command to the pane
shell with no shell-readiness race.

### Checking pane health
```
herdr pane read <paneId> --source visible --lines 1
```
Returns error if pane is dead/invalid.

### Listing panes
```
herdr pane list --workspace wZ
```
Returns array of panes with: `pane_id`, `tab_id`, `agent_status`, `agent`, `cwd`

### Tab reuse strategy

- **Orchestrator**: Reuse existing idle tab if found
  - Check `herdr pane list` for panes with `agent_status === "unknown"`
  - Verify pane alive with `herdr pane read`
  - Rename tab to `"foreveragent (tabs)"`

- **Iteration tabs**: Always create NEW tabs
  - Never reuse to avoid confusion with orchestrator
  - Each iteration gets its own tab with label `"Iteration N"`

## Error Handling

### Model failures
- On timeout: mark model as failed, try next model in list
- After max failures: mark model as `[cooldown]`, continue with next
- 5-min cooldown between attempts per model

### Tab errors
- If `createTab` fails: log warning, continue (tab creation is best-effort)
- If `send-keys` fails: log warning, iteration may hang (poll timeout handles this)

### Child process errors
- If `iter-result.json` not found within timeout: log timeout error
- If `child-config.json` missing: child exits with error
- Child always writes `iter-result.json` (even on error)

## Limitations

1. **No parallel iteration**: Iterations run sequentially
2. **Tab reuse is best-effort**: If pane is dead, falls back to new tab creation
3. **Render is line-based**: Tool results are summarized (not fully shown) in the pane to keep the feed readable; full detail lives in the run log
4. **No pane cleanup**: Old tabs accumulate (user must close manually)
5. **Shell quoting**: Prompt passed via env var to avoid shell escaping issues

## Testing

```sh
cd /home/xlip/work/xlip/foreverAgent
npm test              # Run all tests (55 passing)
node --check src/tabs.mjs     # Syntax check
node --check src/tabs-child.mjs
```

## Usage

```sh
node bin/foreveragent.mjs tabs "Your objective here" \
  --model "llama.cpp/YourModel" \
  --max-iterations 5 \
  --max-consecutive-failures 3 \
  --max-no-ops 3 \
  --agent-timeout 300s \
  --allow-dirty
```

## Current Status

- [x] Design document
- [x] Orchestrator (`tabs.mjs`) with tab lifecycle, model failover, commit/rollback
- [x] Child script (`tabs-child.mjs`) with pi invocation, JSONL parsing, summary banner
- [x] CLI router (`bin/foreveragent.mjs`) for `tabs` subcommand
- [x] Tests pass (55/55)
- [x] Integration test with live llama.cpp server (2-iteration run: success + commit, then no-op -> stalled)
- [x] Iteration tabs display readable output correctly (tool calls, messages, final JSON, summary banner)
- [x] `notes.md` state management across iterations
- [x] Result extraction from final assistant message (handles pretty-printed + fenced JSON)

### Known root cause fixed

The original implementation hung on every iteration because the child **read
`prompt` from config but never passed it to `pi`**, and used `--mode json` with
stdout captured (so nothing was visible). Fixed by passing the prompt as a
positional arg after `--`, rendering each JSONL event as a readable line to the
pane, and executing the child with `herdr pane run`.
