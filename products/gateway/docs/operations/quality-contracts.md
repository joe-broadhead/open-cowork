# Quality Contracts

Gateway tasks can declare a structured `qualitySpec`. The scheduler includes this spec in stage prompts and validates passing review, final, verify, and audit stage results before advancing.

Quality contracts are not software-only. They apply to code, docs, slides, research, operations changes, external-system updates, and mixed deliverables.

## Task Spec

```json
{
  "qualitySpec": {
    "objective": "Ship the dashboard filter without regressing mobile layout.",
    "constraints": ["Preserve existing design system", "Do not add new runtime dependencies"],
    "acceptanceCriteria": ["Filter works for preset and custom date ranges", "Mobile layout remains usable"],
    "definitionOfDone": ["Dashboard filter is usable on desktop and mobile", "Regression checks are recorded"],
    "filesTouched": ["src/dashboard.ts", "src/__tests__/dashboard.test.ts"],
    "systemsTouched": ["Gateway dashboard"],
    "requiredTools": ["node", "actionlint", "uv"],
    "verificationCommands": ["npm test -- dashboard", "npm run typecheck"],
    "rollbackPlan": "Revert the dashboard filter commit and rebuild.",
    "evidenceRequirements": ["test output", "typecheck output"],
    "requiredArtifacts": ["src/dashboard.ts"]
  }
}
```

All fields are optional, but configured acceptance criteria, definition-of-done items, constraints, verification commands, evidence requirements, and required artifacts become deterministic quality gates when a stage returns `pass`. `requiredTools` is checked before Gateway creates an OpenCode stage session.

## Stage Result Contract

Every stage should end with a fenced JSON object:

```json
{
  "status": "pass",
  "summary": "Verified dashboard filter behavior.",
  "feedback": "",
  "failureClass": "verification_failed",
  "artifacts": ["ARTIFACT1 src/dashboard.ts", "CMD1 npm test -- dashboard"],
  "evidence": [
    { "type": "test", "ref": "npm test -- dashboard", "summary": "AC1 filter works for date ranges; EVIDENCE1 test output passed" },
    { "type": "command", "ref": "npm run typecheck", "summary": "DOD1 regression checks recorded; CMD2 typecheck output passed" }
  ],
  "decisions": ["Kept filtering server-rendered to avoid extra client state"]
}
```

Supported `failureClass` values:

- `blocked`
- `needs_user_input`
- `needs_credentials`
- `flaky_test`
- `unsafe`
- `exceeded_budget`
- `unclear_spec`
- `implementation_failed`
- `verification_failed`

Supported evidence types:

- `diff`
- `test`
- `command`
- `link`
- `screenshot`
- `log`
- `decision`
- `file`
- `note`
- `other`

## Deterministic Gates

When a review, final, verify, or audit stage returns `pass`, Gateway checks the task quality spec.

Gateway blocks advancement when required evidence is missing:

- A configured acceptance criterion must be cited by its deterministic ID (`AC1`, `AC2`, ...).
- A configured definition-of-done item must be cited by its deterministic ID (`DOD1`, `DOD2`, ...).
- A configured constraint must be cited by its deterministic ID (`CONSTRAINT1`, `CONSTRAINT2`, ...).
- A configured verification command must be cited by its deterministic ID (`CMD1`, `CMD2`, ...).
- A configured evidence requirement must be cited by its deterministic ID (`EVIDENCE1`, `EVIDENCE2`, ...).
- A configured required artifact must be cited by its deterministic ID (`ARTIFACT1`, `ARTIFACT2`, ...).
- If the spec declares acceptance criteria or required proof, the stage must include at least one artifact or evidence entry.

Review gates require concrete artifacts or evidence, then defer full deterministic ID coverage to verify/final/audit. Missing evidence marks the run failed with `verification_failed` and records actionable feedback that names the missing IDs. Review failures route back to `implement`. Verifier failures with `failureClass: "implementation_failed"` also route back to `implement`; other verifier failures retry verification.

## Preflight Tools

`requiredTools` declares local executables Gateway must see before it creates an OpenCode session for the task. Missing tools block the task with a preflight alert instead of spending tokens on a doomed run.

Supported examples:

- `node`
- `npm`
- `actionlint`
- `uv`
- `rust` (requires both `cargo` and `rustc`)
- `mkdocs` (passes when `mkdocs` is on `PATH`, or when `uv` is on `PATH` and `docs/requirements.txt` exists in the task workdir)

You can also specify tools in task text with a line like `Required tools: actionlint, uv`.

## Review Gate Skill

The default reviewer and verifier profiles load `gateway-review-gate` in addition to `gateway-stage`. The skill adapts autoreview-style scrutiny to the artifact type:

- Code: correctness, regressions, security issues, missing tests, and maintainability.
- Docs/slides: completeness, factual support, audience fit, formatting constraints, and required artifacts.
- Research: source quality, tradeoffs, decision support, and stated failure modes.
- Operations/admin: safety, rollback, audit evidence, and human approval requirements.

Reviewers and verifiers use OpenCode-native questions and permission requests when they need human input or approval. Gateway surfaces those requests through Needs Attention, channels, MCP, and the dashboard.

## Roadmap Memory

Gateway builds bounded roadmap memory from durable task/run data:

- Recent task state.
- Stage decisions.
- Evidence refs.
- Failure classes and feedback.

Surfaces:

- HTTP: `GET /roadmaps/{roadmapId}/memory`.
- MCP: `roadmap_memory`.
- Scheduler prompts include a compact memory block for tasks in the same roadmap.

## Examples

Software:

```json
{
  "objective": "Fix checkout tax rounding.",
  "acceptanceCriteria": ["Totals round consistently", "Existing coupon behavior unchanged"],
  "definitionOfDone": ["Checkout totals match tax rules and existing coupon behavior is preserved"],
  "requiredTools": ["node", "npm"],
  "verificationCommands": ["npm test -- checkout", "npm run typecheck"],
  "evidenceRequirements": ["test output", "typecheck output"],
  "requiredArtifacts": ["src/checkout/totals.ts"]
}
```

Operations:

```json
{
  "objective": "Rotate the webhook secret safely.",
  "constraints": ["No downtime", "Do not paste secrets into task notes"],
  "acceptanceCriteria": ["Old secret revoked", "New webhook health check passes"],
  "definitionOfDone": ["No downtime observed", "Rotation decision is recorded"],
  "verificationCommands": ["opencode-gateway readiness"],
  "rollbackPlan": "Restore previous secret from password manager if health fails.",
  "evidenceRequirements": ["readiness output", "rotation decision"]
}
```

Research:

```json
{
  "objective": "Compare three queue backpressure strategies.",
  "acceptanceCriteria": ["Tradeoffs documented", "Recommendation includes failure modes"],
  "definitionOfDone": ["Recommendation is ready for implementation planning"],
  "evidenceRequirements": ["source links", "decision summary"],
  "requiredArtifacts": ["docs/research/backpressure.md"]
}
```

Personal admin:

```json
{
  "objective": "Prepare renewal checklist.",
  "constraints": ["Do not send emails automatically"],
  "acceptanceCriteria": ["All deadlines captured", "Follow-up draft ready"],
  "definitionOfDone": ["Draft is ready for human review before sending"],
  "evidenceRequirements": ["calendar links", "draft location"]
}
```
