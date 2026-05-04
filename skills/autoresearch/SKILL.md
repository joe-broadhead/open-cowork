---
name: autoresearch
description: Run a Karpathy-style autoresearch loop for measurable improvements. Use when optimizing a skill, prompt, code path, benchmark, or other target with a mechanical metric: baseline, mutate one thing, verify, keep or discard, log, chart progress, and optionally save improved custom skills through the Skills MCP.
---

# Autoresearch

Use this skill when the user wants autonomous, measurable iteration: "run autoresearch", "optimize this skill", "improve this prompt with evals", "make this benchmark better", or "iterate until the metric improves".

The core pattern is Karpathy's autoresearch ratchet:

1. Constrain the target and editable scope.
2. Establish a baseline.
3. Change one thing.
4. Run mechanical verification.
5. Keep only improvements; discard regressions.
6. Log every experiment.
7. Repeat until the budget, plateau rule, or user stop condition is reached.

Open Cowork owns composition only. Do not build a separate runner. Use OpenCode-native editing, shell, approvals, questions, tasks, and skill loading.

## Setup Gate

Do not start experiments until these fields are known:

- Goal: what should improve.
- Target: file path, installed custom skill name, prompt, benchmark, or repo area.
- Mutable scope: exact files or bundle content that may change.
- Read-only scope: files, tests, evaluator code, fixtures, package files, or packaged builtin skills that must not change.
- Metric: a parseable score or binary eval suite.
- Direction: higher is better, lower is better, or pass count is better.
- Verify command or eval protocol: how each candidate is measured.
- Budget: iteration count, time cap, or explicit unbounded run.
- Apply policy: whether to write only a candidate, or apply the final improvement after approval.

If the user did not specify a budget, suggest 10 iterations. Only run unbounded or overnight loops when the user explicitly asks for that.

## Target Modes

### Custom Skill Optimization

When optimizing an installed Open Cowork custom skill:

1. Use the Skills MCP to list and read the custom bundle when available.
2. Copy `SKILL.md` and supporting files into the run directory.
3. Mutate the working copy during experiments.
4. Do not overwrite the installed custom skill during the loop.
5. At the end, ask for or rely on the approval prompt for `save_skill_bundle` before applying the final version.

If a newly saved custom skill is not visible to the native skill loader in the same session, continue evaluating candidates from the working copy content and tell the user that a new thread or runtime refresh may be needed for normal invocation.

### Builtin Skill Optimization

When optimizing a product-shipped skill:

1. Treat packaged skills as read-only unless the user is explicitly working in the Open Cowork repository.
2. Write an optimized candidate in the run directory.
3. Produce a diff and changelog for review.
4. Only edit `skills/<name>/` directly when the user asked for repository changes.

### Code Or Benchmark Optimization

When optimizing code:

1. Inspect git status before editing.
2. Touch only mutable-scope files.
3. Preserve unrelated user changes.
4. Avoid destructive reset commands. Revert only your own experiment edits, preferably by applying a reverse patch or restoring from your saved baseline copy.
5. If the user explicitly approved an experiment branch or worktree, use it for isolation.

## Run Directory

Create a run directory before baseline measurement. Use the user's requested path if provided. Otherwise use:

```text
autoresearch-runs/<target-slug>-<yyyymmdd-hhmm>/
```

If the target is inside a git repository, avoid polluting source control:

1. Check whether the planned run directory is ignored.
2. If it is not ignored, either add an explicit ignore entry when the repo is in mutable scope, use an already ignored local artifact directory, or use a system temp directory.
3. Never stage run artifacts unless the user explicitly asks to preserve them in the PR.

Store:

```text
baseline/
candidate/
outputs/
results.tsv
results.json
changelog.md
evals.md
summary.md
```

For skill optimization, keep the original bundle in `baseline/` and mutate only `candidate/` until final apply.

## Metrics And Evals

Prefer a mechanical metric. Examples:

- benchmark latency, memory, bundle size, accuracy, coverage, error count
- test pass count
- binary skill eval pass count
- LLM judge result only when no deterministic evaluator exists

For skill and prompt optimization, use binary evals. Read `references/eval-guide.md` when writing or reviewing evals.

Each eval must have:

```text
EVAL <n>: <name>
Question: <yes/no question>
Pass: <specific observable pass condition>
Fail: <specific observable fail condition>
```

Avoid vague scores such as "quality 1-10". If a subjective judge is necessary, force yes/no decisions with short evidence.

## Baseline

Experiment 0 is always the unchanged target.

1. Save the baseline copy.
2. Run the verify command or eval protocol.
3. Record the score.
4. Log failure patterns.
5. Create `results.tsv`, `results.json`, and `changelog.md`.

If baseline already satisfies the goal, stop and report that no mutation is needed unless the user explicitly wants further exploration.

## Experiment Loop

For each iteration:

1. Review current best result, recent failures, and changelog.
2. Form one hypothesis.
3. Make one focused mutation.
4. Run verification with the same metric and comparable inputs.
5. Decide:
   - Improved: keep the mutation as the new candidate.
   - Equal but simpler: keep if complexity decreased and behavior did not regress.
   - Equal but not simpler: discard.
   - Worse or crash: discard unless the crash is a trivial implementation mistake inside the mutation.
6. Append logs.
7. Update charts when enough data exists.

Good mutations:

- clarify an ambiguous instruction
- add a missing guardrail
- move a critical rule earlier
- add a small worked example
- remove an instruction that causes failures
- adjust one parameter or implementation choice

Bad mutations:

- broad rewrites
- multiple unrelated changes
- changing the evaluator to improve the score
- adding dependencies without explicit approval
- optimizing for an eval loophole instead of the user's real goal

## Logging Contract

Use tab-separated rows:

```text
experiment	score	max_score	pass_rate	status	description
0	14	20	70.0	baseline	original target
1	16	20	80.0	keep	clarified binary eval format
2	15	20	75.0	discard	added broad style rules
```

`status` should be one of:

- `baseline`
- `keep`
- `discard`
- `crash`
- `skipped`

Keep `results.json` chart-ready:

```json
{
  "target": "skill-creator",
  "status": "running",
  "direction": "higher",
  "current_experiment": 2,
  "best_score": 16,
  "max_score": 20,
  "experiments": [
    {
      "id": 0,
      "score": 14,
      "max_score": 20,
      "pass_rate": 70.0,
      "status": "baseline",
      "description": "original target"
    }
  ],
  "eval_breakdown": [
    {
      "name": "Binary evals",
      "pass_count": 8,
      "total": 10
    }
  ]
}
```

Append `changelog.md` after every experiment:

```markdown
## Experiment <n> - <status>

Score: <score>/<max> (<pass_rate>%)
Change: <one sentence>
Reasoning: <why this should help>
Result: <what changed in the metric>
Remaining failures: <short evidence>
```

## Charts

When the Charts MCP is available, create native Open Cowork charts from `results.json` data:

- Use `charts_line_chart` for score or pass-rate trend over experiment number.
- Use `charts_bar_chart` for keep/discard/crash counts.
- Use `charts_bar_chart` for per-eval pass rate.
- Use `charts_mermaid` for the final mutate -> verify -> keep/discard flow only when a process diagram helps.

Do not create an HTML dashboard with CDN dependencies. Prefer in-app chart artifacts.

## Final Apply

At the end:

1. Summarize baseline to final score.
2. Report iterations, keep rate, and stopped reason.
3. Link or name `results.tsv`, `results.json`, and `changelog.md`.
4. List the top changes that helped.
5. List remaining failure patterns.
6. For custom skills, apply the candidate with the Skills MCP only after approval.
7. For builtin skills, leave a candidate patch or apply it to the repo only when the user explicitly asked for repo edits.

## Done Criteria

An autoresearch run is good when:

- baseline was measured first
- evals or metrics were fixed before mutation
- only one meaningful thing changed per iteration
- every result was logged
- failures were discarded without losing unrelated user work
- final output includes the improved candidate and evidence
- charts were produced when chart data existed and the Charts MCP was available
