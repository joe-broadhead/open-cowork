import { spawnSync } from 'node:child_process'

const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

export function validateReleaseMetadata(input) {
  const failures = []
  const expectedTag = `v${input.packageVersion}`

  if (!SEMVER.test(input.packageVersion)) {
    failures.push({ gate: 'version_alignment', message: `package.json version ${input.packageVersion} is not valid semver` })
  }
  if (input.packageVersion !== input.lockVersion) {
    failures.push({ gate: 'version_alignment', message: `package.json ${input.packageVersion} != package-lock.json ${input.lockVersion}` })
  }
  if (input.packageVersion !== input.lockRootVersion) {
    failures.push({ gate: 'version_alignment', message: `package.json ${input.packageVersion} != package-lock root package ${input.lockRootVersion || 'missing'}` })
  }

  const heading = new RegExp(`^## ${escapeRegex(expectedTag)}(?: - \\d{4}-\\d{2}-\\d{2})?$`, 'gm')
  const headings = input.changelog.match(heading) || []
  if (headings.length !== 1) {
    failures.push({
      gate: 'version_alignment',
      message: `CHANGELOG.md must contain exactly one release heading for ${expectedTag}; found ${headings.length}`,
    })
  }

  if (input.releaseTag !== undefined && input.releaseTag !== expectedTag) {
    failures.push({ gate: 'release_tag', message: `release tag ${input.releaseTag} must exactly equal ${expectedTag}` })
  }

  return { expectedTag, failures }
}

export function verifyReleaseGitBinding(input) {
  const failures = []
  const tagRef = `refs/tags/${input.releaseTag}`
  const tagCommit = resolveCommit(input.root, tagRef)
  const headCommit = resolveCommit(input.root, 'HEAD')
  const mainCommit = resolveCommit(input.root, input.mainRef)

  if (!tagCommit.ok) failures.push({ gate: 'release_tag', message: `${tagRef} does not resolve to a commit: ${tagCommit.detail}` })
  if (!headCommit.ok) failures.push({ gate: 'release_tag', message: `HEAD does not resolve to a commit: ${headCommit.detail}` })
  if (!mainCommit.ok) failures.push({ gate: 'main_ancestry', message: `${input.mainRef} does not resolve to the protected main commit: ${mainCommit.detail}` })
  if (failures.length > 0) return { failures }

  if (tagCommit.commit !== headCommit.commit) {
    failures.push({
      gate: 'release_tag',
      message: `${tagRef} resolves to ${tagCommit.commit}, but workflow HEAD is ${headCommit.commit}`,
    })
  }

  const ancestry = spawnSync('git', ['merge-base', '--is-ancestor', tagCommit.commit, mainCommit.commit], {
    cwd: input.root,
    encoding: 'utf8',
  })
  if (ancestry.status !== 0) {
    failures.push({
      gate: 'main_ancestry',
      message: ancestry.status === 1
        ? `${tagRef} commit ${tagCommit.commit} is not an ancestor of protected ${input.mainRef} (${mainCommit.commit})`
        : `could not verify ${tagRef} ancestry against ${input.mainRef}: ${commandDetail(ancestry)}`,
    })
  }

  return {
    failures,
    tagCommit: tagCommit.commit,
    mainCommit: mainCommit.commit,
  }
}

function resolveCommit(root, ref) {
  const result = spawnSync('git', ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], {
    cwd: root,
    encoding: 'utf8',
  })
  if (result.status !== 0) return { ok: false, detail: commandDetail(result) }
  return { ok: true, commit: result.stdout.trim() }
}

function commandDetail(result) {
  return String(result.stderr || result.stdout || `git exited ${result.status}`).trim()
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
