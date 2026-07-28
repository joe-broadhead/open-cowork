import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SOURCE_TEST_FILE = /\.(?:spec|test)\.[cm]?[jt]sx?$/
const SOURCE_TEST_DIRECTORIES = new Set(['__tests__', 'test', 'tests'])
const TYPESCRIPT_SOURCE_FILE = /\.[cm]?tsx?$/
const TYPESCRIPT_DECLARATION_FILE = /\.d\.[cm]?ts$/

function packageManifest(packageRoot) {
  return JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
}

function filesIn(directory, {
  excludeTests = false,
  include = () => true,
} = {}) {
  if (!existsSync(directory)) return []
  const files = []
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const entryPath = join(current, entry.name)
      if (entry.isDirectory()) {
        if (excludeTests && SOURCE_TEST_DIRECTORIES.has(entry.name)) continue
        visit(entryPath)
        continue
      }
      if (!entry.isFile()
        || (excludeTests && SOURCE_TEST_FILE.test(entry.name))
        || !include(entry.name)) continue
      files.push({
        modifiedAt: statSync(entryPath).mtimeMs,
        path: entryPath,
      })
    }
  }
  visit(directory)
  return files
}

function newestFile(directory, options) {
  return filesIn(directory, options).reduce(
    (newest, file) => !newest || file.modifiedAt > newest.modifiedAt ? file : newest,
    null,
  )
}

function emittedJavaScriptPath(sourceRoot, outputRoot, sourcePath) {
  const sourceRelativePath = relative(sourceRoot, sourcePath)
  const outputExtension = sourceRelativePath.endsWith('.mts')
    ? '.mjs'
    : sourceRelativePath.endsWith('.cts')
      ? '.cjs'
      : '.js'
  return join(
    outputRoot,
    sourceRelativePath.replace(TYPESCRIPT_SOURCE_FILE, outputExtension),
  )
}

function packagePublishesDist(manifest) {
  return JSON.stringify({
    exports: manifest.exports,
    main: manifest.main,
    module: manifest.module,
    types: manifest.types,
  }).includes('dist/')
}

export function inspectPackageBuildFreshness(packageRoot) {
  const manifest = packageManifest(packageRoot)
  const packageName = manifest.name || relative(process.cwd(), packageRoot) || packageRoot
  const sourceRoot = join(packageRoot, 'src')
  const outputRoot = join(packageRoot, 'dist')
  const newestSource = newestFile(sourceRoot, { excludeTests: true })
  if (!newestSource) return null
  const newestOutput = newestFile(outputRoot)
  if (!newestOutput) {
    return {
      packageName,
      reason: 'missing dist output',
    }
  }

  if (/\btsc\b/.test(manifest.scripts?.build || '')) {
    const typescriptSources = filesIn(sourceRoot, {
      excludeTests: true,
      include: (fileName) => TYPESCRIPT_SOURCE_FILE.test(fileName)
        && !TYPESCRIPT_DECLARATION_FILE.test(fileName),
    })
    for (const source of typescriptSources) {
      const outputPath = emittedJavaScriptPath(sourceRoot, outputRoot, source.path)
      if (!existsSync(outputPath)) {
        return {
          packageName,
          reason: `missing ${relative(packageRoot, outputPath)} for ${relative(packageRoot, source.path)}`,
        }
      }
      if (source.modifiedAt > statSync(outputPath).mtimeMs) {
        return {
          packageName,
          reason: `${relative(packageRoot, source.path)} is newer than ${relative(packageRoot, outputPath)}`,
        }
      }
    }
    return null
  }

  if (newestSource.modifiedAt > newestOutput.modifiedAt) {
    return {
      packageName,
      reason: `${relative(packageRoot, newestSource.path)} is newer than dist output`,
    }
  }
  return null
}

function workspaceDependencyRoot(packageRoot, dependencyName) {
  const dependencyPath = join(packageRoot, 'node_modules', ...dependencyName.split('/'))
  if (!existsSync(dependencyPath)) return null
  return realpathSync(dependencyPath)
}

export function inspectWorkspaceBuildFreshness(
  packageRoot,
  {
    includeSelf = false,
  } = {},
) {
  const findings = []
  const visited = new Set()
  const queue = [{ packageRoot: realpathSync(packageRoot), inspect: includeSelf }]

  while (queue.length > 0) {
    const next = queue.shift()
    if (!next || visited.has(next.packageRoot)) continue
    visited.add(next.packageRoot)
    const manifest = packageManifest(next.packageRoot)
    if (next.inspect && packagePublishesDist(manifest) && manifest.scripts?.build) {
      const finding = inspectPackageBuildFreshness(next.packageRoot)
      if (finding) findings.push(finding)
    }

    const dependencies = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.optionalDependencies,
    }
    for (const [dependencyName, version] of Object.entries(dependencies)) {
      if (typeof version !== 'string' || !version.startsWith('workspace:')) continue
      const dependencyRoot = workspaceDependencyRoot(next.packageRoot, dependencyName)
      if (!dependencyRoot) {
        findings.push({
          packageName: dependencyName,
          reason: `workspace link is missing from ${manifest.name || next.packageRoot}`,
        })
        continue
      }
      queue.push({ packageRoot: dependencyRoot, inspect: true })
    }
  }

  return findings
}

function runCli() {
  const packageRoot = process.cwd()
  const findings = inspectWorkspaceBuildFreshness(packageRoot, {
    includeSelf: process.argv.includes('--self'),
  })
  if (findings.length === 0) return
  const manifest = packageManifest(packageRoot)
  const details = findings
    .map(({ packageName, reason }) => `- ${packageName}: ${reason}`)
    .join('\n')
  process.stderr.write(
    `Build artifacts required by ${manifest.name || packageRoot} are missing or stale:\n`
    + `${details}\n`
    + 'Run the root test preparation or the affected package builds before this scoped test.\n',
  )
  process.exitCode = 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli()
}
