// Build the iteration prompt sent to the agent.

export const RESULT_SCHEMA_NOTE = `Your FINAL message must be exactly one JSON object, no markdown fences, no prose before or after:

{
  "success": true,
  "summary": "one sentence: what this iteration accomplished",
  "key_changes_made": ["logical outcome, not file-by-file activity"],
  "key_learnings": ["anything surprising or useful for future iterations"],
  "should_stop": false
}`;

export function buildIterationPrompt(params) {
  const { n, runId, objective, stopWhen } = params;
  const stopSection = stopWhen
    ? `
## Stop Condition

The run ends when this condition is met: ${stopWhen}
If, after this iteration's work, the condition is fully met, set "should_stop": true in your final JSON. Otherwise set it to false.
`
    : `
## No Stop Condition - The Run Never Ends on Its Own

This run has no stop condition, which means you will NEVER be the one to end it. Do NOT set "should_stop": true under any circumstances - the orchestrator keeps the run going.
When the objective is (or becomes) fully met, do not sit still: keep looking for things to improve and dig into the single most promising one each iteration - e.g. quality, robustness, edge cases, performance, test coverage, dead code, confusing or duplicated logic, documentation. Try hard: pick the improvement that most increases confidence the product works as a user would expect, and make real, verifiable progress on it this iteration.`;

  return `You are working autonomously towards an objective given below.
This is iteration ${n} of an unattended run. Make ONE small, verifiable step forward - not the whole objective.

## Instructions

1. First read .foreveragent/runs/${runId}/notes.md to see what previous iterations did. Do NOT modify notes.md - the orchestrator maintains it.
2. Pick the next smallest logical unit of work that is individually verifiable and moves the objective forward. That is the scope of this iteration.
3. If the objective (or stop condition, if any) is already fully met, see the stop section below: with a stop condition set "should_stop": true; with no stop condition, keep working on the next improvement instead.
4. If you make code changes, run the available tests / build / linter to validate. Do NOT run any git commands - the orchestrator commits or rolls back for you.
5. Stop any background processes you started (dev servers, watchers, browsers) before finishing.
6. If you could not make meaningful progress this iteration, say so honestly with "success": false - the orchestrator will roll back your changes and try again later. A no-op iteration is not a success.
7. Only send the final JSON when everything above is done.

## Output

${RESULT_SCHEMA_NOTE}

- "success": false means every change you made should be discarded.
- "should_stop": ${stopWhen ? 'true only when the objective (or stop condition) is fully met' : 'always false, because this run has no stop condition'}.${stopSection}
## Objective

${objective}
`;
}
