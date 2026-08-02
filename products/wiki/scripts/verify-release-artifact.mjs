import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const wikiRoot = join(scriptDirectory, '..')
const tag = process.argv[2]
const artifactsDirectory = process.argv[3]

if (!tag || !artifactsDirectory) {
  fail('Usage: verify-release-artifact.mjs <wiki-tag|manual> <artifacts-directory>')
}

const wikiPackage = readJson(join(wikiRoot, 'package.json'), 'Wiki package manifest')
const manual = tag === 'manual'
const tagMatch = manual
  ? null
  : /^wiki(?:@v|-v)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/.exec(tag)
if (!manual && !tagMatch) {
  fail(`Unsupported Wiki release tag: ${tag}`)
}
const tagVersion = tagMatch?.[1] || wikiPackage.version
const prerelease = tagVersion.split('+', 1)[0].includes('-')

if (tagVersion !== wikiPackage.version) {
  fail(`Wiki tag version ${tagVersion} does not match Wiki package version ${wikiPackage.version}`)
}

const tarballs = readdirSync(artifactsDirectory, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.tgz'))
  .map((entry) => join(artifactsDirectory, entry.name))

if (tarballs.length !== 1) {
  fail(`Expected exactly one packed Wiki CLI tarball; found ${tarballs.length}`)
}

const [tarball] = tarballs
const expectedBasename = `openwiki-cli-${wikiPackage.version}.tgz`
if (basename(tarball) !== expectedBasename) {
  fail(`Wiki tarball basename ${basename(tarball)} does not match expected ${expectedBasename}`)
}

const extractedManifest = spawnSync('tar', ['-xOf', tarball, 'package/package.json'], {
  encoding: 'utf8',
  maxBuffer: 1024 * 1024,
})
if (extractedManifest.error || extractedManifest.status !== 0) {
  fail(`Could not read package/package.json from ${basename(tarball)}`)
}

let cliPackage
try {
  cliPackage = JSON.parse(extractedManifest.stdout)
} catch {
  fail(`Invalid package/package.json in ${basename(tarball)}`)
}

if (cliPackage.name !== '@openwiki/cli') {
  fail(`Wiki tarball package name ${cliPackage.name} does not match expected @openwiki/cli`)
}

if (cliPackage.version !== wikiPackage.version) {
  fail(`Wiki tarball package version ${cliPackage.version} does not match Wiki package version ${wikiPackage.version}`)
}

process.stdout.write(`tarball=${tarball}\nprerelease=${prerelease}\n`)

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    fail(`Could not read ${label}`)
  }
}

function fail(message) {
  console.error(`::error::${message}`)
  process.exit(1)
}
