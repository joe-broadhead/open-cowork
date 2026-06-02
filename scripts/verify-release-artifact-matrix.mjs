import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export function expectedReleaseArtifacts(version) {
  return {
    macos: [
      `Open-Cowork-${version}-x64.dmg`,
      `Open-Cowork-${version}-arm64.dmg`,
      `Open-Cowork-${version}-x64-mac.zip`,
      `Open-Cowork-${version}-arm64-mac.zip`,
    ],
    linux: [
      `Open-Cowork-${version}-x64.AppImage`,
      `Open-Cowork-${version}-x64.deb`,
    ],
  }
}

function assertNonEmptyFile(path) {
  if (!existsSync(path)) throw new Error(`Missing release artifact: ${path}`)
  if (!statSync(path).isFile()) throw new Error(`Release artifact is not a file: ${path}`)
  if (statSync(path).size <= 0) throw new Error(`Release artifact is empty: ${path}`)
}

function listInstallerArtifacts(root, directory, extensions) {
  const dir = join(root, directory)
  if (!existsSync(dir)) throw new Error(`Missing release artifact directory: ${dir}`)
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => extensions.some((extension) => name.endsWith(extension)))
    .sort()
}

export function verifyReleaseArtifactMatrix(input) {
  const root = input.root || 'dist-artifacts'
  const version = input.version?.trim()
  const signingMode = input.signingMode?.trim()
  if (!version) throw new Error('Release artifact matrix verification requires --version.')
  if (signingMode !== 'signed' && signingMode !== 'unsigned') {
    throw new Error('Release artifact matrix verification requires --signing-mode signed or unsigned.')
  }

  const expected = expectedReleaseArtifacts(version)
  for (const artifact of expected.macos) assertNonEmptyFile(join(root, 'release-macos', artifact))
  for (const artifact of expected.linux) assertNonEmptyFile(join(root, 'release-linux', artifact))

  const actualMacos = listInstallerArtifacts(root, 'release-macos', ['.dmg', '.zip'])
  const actualLinux = listInstallerArtifacts(root, 'release-linux', ['.AppImage', '.deb'])
  const unexpectedMacos = actualMacos.filter((artifact) => !expected.macos.includes(artifact))
  const unexpectedLinux = actualLinux.filter((artifact) => !expected.linux.includes(artifact))
  if (unexpectedMacos.length > 0) {
    throw new Error(`Unexpected macOS release artifacts: ${unexpectedMacos.join(', ')}`)
  }
  if (unexpectedLinux.length > 0) {
    throw new Error(`Unexpected Linux release artifacts: ${unexpectedLinux.join(', ')}`)
  }

  const latestMac = join(root, 'release-macos', 'latest-mac.yml')
  if (signingMode === 'signed') {
    assertNonEmptyFile(latestMac)
  } else if (existsSync(latestMac)) {
    throw new Error('Unsigned macOS preview artifacts must not publish latest-mac.yml feed metadata.')
  }
}

function readArgs(argv) {
  const input = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = argv[index + 1]
    if (arg === '--root' && next) {
      input.root = next
      index += 1
    } else if (arg === '--version' && next) {
      input.version = next
      index += 1
    } else if (arg === '--signing-mode' && next) {
      input.signingMode = next
      index += 1
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`)
    }
  }
  return input
}

export function main(argv = process.argv.slice(2)) {
  verifyReleaseArtifactMatrix(readArgs(argv))
  process.stdout.write('[release-artifact-matrix] release artifact matrix verified\n')
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[release-artifact-matrix] ${message}`)
    process.exitCode = 1
  }
}
