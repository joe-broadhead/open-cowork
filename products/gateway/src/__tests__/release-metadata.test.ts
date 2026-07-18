import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const root = path.resolve(import.meta.dirname, '..', '..')
const temporaryRepositories: string[] = []

async function metadataModule(): Promise<any> {
  return import(pathToFileURL(path.join(root, 'scripts/check-release-metadata.mjs')).href)
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function repository(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-release-metadata-'))
  temporaryRepositories.push(directory)
  git(directory, 'init', '-q', '-b', 'main')
  git(directory, 'config', 'user.name', 'Release Test')
  git(directory, 'config', 'user.email', 'release-test@example.invalid')
  fs.writeFileSync(path.join(directory, 'fixture.txt'), 'base\n')
  git(directory, 'add', 'fixture.txt')
  git(directory, 'commit', '-q', '-m', 'base')
  return directory
}

afterEach(() => {
  for (const directory of temporaryRepositories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('release metadata binding', () => {
  it('requires exact package, lock, changelog, and tag versions', async () => {
    const { validateReleaseMetadata } = await metadataModule()
    const pass = validateReleaseMetadata({
      packageVersion: '1.3.0',
      lockVersion: '1.3.0',
      lockRootVersion: '1.3.0',
      changelog: '# Changelog\n\n## v1.3.0 - 2026-07-04\n',
      releaseTag: 'v1.3.0',
    })
    expect(pass.failures).toEqual([])

    const fail = validateReleaseMetadata({
      packageVersion: '1.3.0',
      lockVersion: '1.3.1',
      lockRootVersion: '1.3.0',
      changelog: '## v1.3.0\n## v1.3.0 - 2026-07-04\n',
      releaseTag: 'v1.3.0-rc.1',
    })
    expect(fail.failures.map((row: any) => row.gate)).toEqual(expect.arrayContaining(['version_alignment', 'release_tag']))
    expect(fail.failures.map((row: any) => row.message).join('\n')).toContain('exactly one release heading')
  })

  it('accepts only a workflow HEAD tag that is reachable from protected main', async () => {
    const { verifyReleaseGitBinding } = await metadataModule()
    const directory = repository()
    git(directory, 'tag', '-a', 'v1.3.0', '-m', 'release')

    expect(verifyReleaseGitBinding({ root: directory, releaseTag: 'v1.3.0', mainRef: 'refs/heads/main' })).toMatchObject({
      failures: [],
      tagCommit: git(directory, 'rev-parse', 'HEAD'),
    })
  })

  it('rejects a protected-main tag that does not resolve to workflow HEAD', async () => {
    const { verifyReleaseGitBinding } = await metadataModule()
    const directory = repository()
    git(directory, 'tag', '-a', 'v1.3.0', '-m', 'release')
    fs.appendFileSync(path.join(directory, 'fixture.txt'), 'later main commit\n')
    git(directory, 'add', 'fixture.txt')
    git(directory, 'commit', '-q', '-m', 'later main commit')

    const result = verifyReleaseGitBinding({ root: directory, releaseTag: 'v1.3.0', mainRef: 'refs/heads/main' })
    expect(result.failures).toContainEqual(expect.objectContaining({ gate: 'release_tag' }))
    expect(result.failures.map((row: any) => row.message).join('\n')).toContain('workflow HEAD')
  })

  it('rejects a correctly named tag whose commit is not on protected main', async () => {
    const { verifyReleaseGitBinding } = await metadataModule()
    const directory = repository()
    git(directory, 'switch', '-q', '-c', 'forged-release')
    fs.appendFileSync(path.join(directory, 'fixture.txt'), 'off-main\n')
    git(directory, 'add', 'fixture.txt')
    git(directory, 'commit', '-q', '-m', 'off-main release')
    git(directory, 'tag', '-a', 'v1.3.0', '-m', 'forged release')

    const result = verifyReleaseGitBinding({ root: directory, releaseTag: 'v1.3.0', mainRef: 'refs/heads/main' })
    expect(result.failures).toContainEqual(expect.objectContaining({ gate: 'main_ancestry' }))
    expect(result.failures.map((row: any) => row.message).join('\n')).toContain('is not an ancestor')
  })
})
