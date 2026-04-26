import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const releaseDir = resolve(process.cwd(), 'apps/desktop/release')

function collectExecutables(root, candidates) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const entryPath = join(root, entry.name)
    if (entry.isDirectory()) {
      if (entry.name.endsWith('.app')) {
        const macOsDir = join(entryPath, 'Contents', 'MacOS')
        if (existsSync(macOsDir)) {
          for (const executable of readdirSync(macOsDir)) {
            candidates.push(join(macOsDir, executable))
          }
        }
        continue
      }
      collectExecutables(entryPath, candidates)
    }
  }
}

function scoreCandidate(candidate) {
  const preferredArch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const matchesPreferredArch = candidate.includes(preferredArch)
  return [
    matchesPreferredArch ? 0 : 1,
    candidate.length,
    candidate,
  ]
}

if (!existsSync(releaseDir)) {
  console.error(`Release directory not found: ${releaseDir}`)
  process.exit(1)
}

const candidates = []
collectExecutables(releaseDir, candidates)

if (candidates.length === 0) {
  console.error(`No packaged macOS executable found under ${releaseDir}`)
  process.exit(1)
}

candidates.sort((left, right) => {
  const leftScore = scoreCandidate(left)
  const rightScore = scoreCandidate(right)
  for (let index = 0; index < leftScore.length; index += 1) {
    if (leftScore[index] < rightScore[index]) return -1
    if (leftScore[index] > rightScore[index]) return 1
  }
  return 0
})

process.stdout.write(candidates[0])
