# Eval Guide

Use this reference when creating or reviewing evals for skill and prompt optimization.

## Rule

Every eval should be a yes/no question with a specific observable pass condition.

Binary evals reduce scoring variance. Numeric scales like 1-5 or 1-10 are usually too noisy for an autoresearch loop because small judge preference changes look like real progress.

## Template

```text
EVAL <n>: <short name>
Question: <yes/no question>
Pass: <specific observable pass condition>
Fail: <specific observable fail condition>
```

## Good Evals

Text or communication:

- Does the answer avoid every phrase in this banned list?
- Does the first paragraph contain a concrete date, number, source, or file reference?
- Is the answer under the requested word count?
- Does the answer include a clear next action when one is required?

Visual or chart output:

- Is every visible label complete and non-overlapping?
- Does the chart include title, units, and unambiguous axis labels?
- Does the visual use the requested chart type or a clearly justified alternative?
- Is the output free of invented rows, units, categories, or dates?

Code output:

- Does the verification command exit successfully?
- Does the changed code avoid TODO placeholders?
- Are all externally visible behavior changes covered by a targeted test?
- Does the implementation avoid touching files outside the approved mutable scope?

Skill output:

- Does the skill description clearly say when the skill should trigger?
- Does the workflow require gathering missing inputs before execution?
- Does the skill state how to use each required MCP or tool?
- Does the skill include a concrete done condition?

## Bad Evals

Avoid:

- "Is it good?"
- "Rate quality from 1 to 10."
- "Does it feel professional?"
- "Would a human like it?"
- "Does it contain exactly three bullets?" unless exactly three bullets is truly required.

## Three Checks

Before using an eval, ask:

1. Would two independent agents usually score the same output the same way?
2. Could the target game this eval without improving the real task?
3. Does the eval test something the user actually cares about?

Drop or rewrite evals that fail any check.

## Scoring

For each experiment:

```text
max_score = number_of_evals * number_of_runs
score = count_of_passed_eval_checks
pass_rate = score / max_score * 100
```

When deterministic commands exist, prefer them over LLM judging. When LLM judging is necessary, require a yes/no answer plus short evidence for each eval.
