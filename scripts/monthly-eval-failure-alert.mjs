#!/usr/bin/env node
/**
 * JOE-926: After a failed Monthly UI Evals run, open (or comment on) a GitHub
 * issue when the last N consecutive workflow runs on this branch failed.
 *
 * Usage (from Actions, after a failed eval job):
 *   node scripts/monthly-eval-failure-alert.mjs
 *
 * Env:
 *   GITHUB_TOKEN / GH_TOKEN  — required (issues:write)
 *   GITHUB_REPOSITORY        — owner/repo (default from Actions)
 *   GITHUB_REF_NAME          — branch (default: master)
 *   GITHUB_RUN_ID            — current run id (for the issue body)
 *   GITHUB_SERVER_URL        — default https://github.com
 *   OPEN_COWORK_EVAL_FAIL_STREAK — consecutive failures required (default: 2)
 *   OPEN_COWORK_EVAL_WORKFLOW    — workflow file name (default: monthly-evals.yml)
 */

import { execFileSync } from 'node:child_process'

const workflow = process.env.OPEN_COWORK_EVAL_WORKFLOW?.trim() || 'monthly-evals.yml'
const streakNeeded = Math.max(1, Number.parseInt(process.env.OPEN_COWORK_EVAL_FAIL_STREAK || '2', 10) || 2)
const repo = process.env.GITHUB_REPOSITORY?.trim()
const branch = process.env.GITHUB_REF_NAME?.trim() || 'master'
const runId = process.env.GITHUB_RUN_ID?.trim() || ''
const server = (process.env.GITHUB_SERVER_URL || 'https://github.com').replace(/\/$/, '')
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN

if (!repo) {
  console.error('monthly-eval-failure-alert: GITHUB_REPOSITORY is required')
  process.exit(1)
}
if (!token) {
  console.error('monthly-eval-failure-alert: GITHUB_TOKEN/GH_TOKEN is required')
  process.exit(1)
}

const env = {
  ...process.env,
  GH_TOKEN: token,
  GITHUB_TOKEN: token,
}

function ghJson(args) {
  const out = execFileSync('gh', args, { encoding: 'utf8', env, maxBuffer: 8 * 1024 * 1024 })
  return JSON.parse(out)
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', env, maxBuffer: 8 * 1024 * 1024 }).trim()
}

// Most recent completed runs for this workflow on the branch (includes the
// current failure if it has already been marked completed).
const runs = ghJson([
  'run', 'list',
  '--repo', repo,
  '--workflow', workflow,
  '--branch', branch,
  '--limit', String(Math.max(streakNeeded + 2, 5)),
  '--json', 'databaseId,conclusion,status,url,displayTitle,createdAt,headSha',
])

const completed = runs.filter((run) => run.status === 'completed')
const consecutiveFailures = []
for (const run of completed) {
  if (run.conclusion === 'failure' || run.conclusion === 'timed_out') {
    consecutiveFailures.push(run)
    continue
  }
  break
}

if (consecutiveFailures.length < streakNeeded) {
  console.log(
    `monthly-eval-failure-alert: streak=${consecutiveFailures.length} < threshold=${streakNeeded}; no issue`,
  )
  process.exit(0)
}

const title = `[monthly-evals] ${consecutiveFailures.length} consecutive failures on ${branch}`
const runLinks = consecutiveFailures
  .map((run) => `- ${run.url} (\`${(run.headSha || '').slice(0, 7)}\`, ${run.conclusion}, ${run.createdAt})`)
  .join('\n')
const currentUrl = runId ? `${server}/${repo}/actions/runs/${runId}` : consecutiveFailures[0]?.url
const body = [
  '## Monthly UI Evals consecutive failure alert',
  '',
  `Threshold: **${streakNeeded}** consecutive completed failures on \`${branch}\` for \`${workflow}\`.`,
  '',
  `Current run: ${currentUrl}`,
  '',
  '### Recent failures (newest first)',
  runLinks,
  '',
  '### Owner / follow-up',
  '- Epic: restore UI eval product contracts (admin nav + approval projection)',
  '- Re-run: Actions → Monthly UI Evals → Run workflow',
  '- Local: `pnpm test:e2e:evals` (needs display / xvfb)',
  '',
  '### Silence',
  'Close this issue after a green monthly-evals run, or after accepting residual risk with rationale.',
  '',
  `<!-- open-cowork-monthly-eval-alert:${branch} -->`,
].join('\n')

const marker = `<!-- open-cowork-monthly-eval-alert:${branch} -->`
const existing = ghJson([
  'issue', 'list',
  '--repo', repo,
  '--state', 'open',
  '--limit', '50',
  '--json', 'number,title,body',
]).filter((issue) => typeof issue.body === 'string' && issue.body.includes(marker))

if (existing.length > 0) {
  const issue = existing[0]
  const comment = [
    `Another consecutive failure (streak ≥ ${streakNeeded}).`,
    '',
    `Run: ${currentUrl}`,
    '',
    '### Failure window',
    runLinks,
  ].join('\n')
  gh(['issue', 'comment', String(issue.number), '--repo', repo, '--body', comment])
  console.log(`monthly-eval-failure-alert: commented on existing issue #${issue.number}`)
  process.exit(0)
}

const created = gh([
  'issue', 'create',
  '--repo', repo,
  '--title', title,
  '--body', body,
  '--label', 'bug',
])
console.log(`monthly-eval-failure-alert: opened ${created}`)
