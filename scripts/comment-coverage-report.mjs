import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const marker = '<!-- open-cowork-coverage-summary -->'
const repository = process.env.GITHUB_REPOSITORY
const prNumber = process.env.PR_NUMBER

if (!repository || !prNumber) {
  console.error('GITHUB_REPOSITORY and PR_NUMBER are required')
  process.exit(1)
}

const body = readFileSync('coverage/coverage-summary.md', 'utf8')
const commentsResult = spawnSync('gh', [
  'api',
  `repos/${repository}/issues/${prNumber}/comments`,
  '--paginate',
  '--jq',
  `.[] | select(.user.type == "Bot" and (.body | contains("${marker}"))) | .id`,
], { encoding: 'utf8' })

if (commentsResult.status !== 0) {
  process.stderr.write(commentsResult.stderr)
  process.exit(commentsResult.status ?? 1)
}

const existingCommentId = commentsResult.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1)
const args = existingCommentId
  ? ['api', `repos/${repository}/issues/comments/${existingCommentId}`, '--method', 'PATCH', '--field', `body=${body}`]
  : ['api', `repos/${repository}/issues/${prNumber}/comments`, '--method', 'POST', '--field', `body=${body}`]

const updateResult = spawnSync('gh', args, { stdio: 'inherit' })
process.exit(updateResult.status ?? 1)
