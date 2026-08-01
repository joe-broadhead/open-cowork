#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DOCUMENTATION_SCREENSHOT_JOURNEYS } from '../apps/desktop/tests/documentation-screenshot-journeys.mjs'

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function markdownFiles(directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return markdownFiles(path)
    return entry.isFile() && entry.name.endsWith('.md') ? [path] : []
  })
}

export function validateDocumentationScreenshots({
  root = defaultRoot,
  journeys = DOCUMENTATION_SCREENSHOT_JOURNEYS,
} = {}) {
  const errors = []
  const assetsDir = join(root, 'docs/assets/auto')
  const ids = new Set()
  const routes = new Set()

  for (const journey of journeys) {
    if (!journey?.id || !journey.route || !journey.owner || !journey.doc) {
      errors.push('Each screenshot journey needs id, route, owner, and doc fields.')
      continue
    }
    if (ids.has(journey.id)) errors.push(`Duplicate screenshot id: ${journey.id}`)
    if (routes.has(journey.route)) errors.push(`Duplicate screenshot route/state: ${journey.route}`)
    ids.add(journey.id)
    routes.add(journey.route)

    const docPath = join(root, journey.doc)
    if (!existsSync(docPath)) {
      errors.push(`${journey.id}: owner ${journey.owner} references missing ${journey.doc}`)
      continue
    }
    const reference = `assets/auto/${journey.id}.png`
    if (!readFileSync(docPath, 'utf8').includes(reference)) {
      errors.push(`${journey.id}: ${journey.doc} must reference ${reference} (owner: ${journey.owner})`)
    }
  }

  const pngs = existsSync(assetsDir)
    ? readdirSync(assetsDir).filter((file) => file.endsWith('.png')).sort()
    : []
  const expected = [...ids].map((id) => `${id}.png`).sort()
  for (const file of expected) {
    if (!pngs.includes(file)) errors.push(`Missing generated screenshot: docs/assets/auto/${file}`)
  }
  for (const file of pngs) {
    if (!expected.includes(file)) errors.push(`Unreferenced generated screenshot: docs/assets/auto/${file}`)
  }

  const referencePattern = /(?:\.\.\/)*assets\/auto\/([a-z0-9-]+\.png)/g
  const publicMarkdown = [
    ...markdownFiles(join(root, 'docs')),
    ...(existsSync(join(root, 'README.md')) ? [join(root, 'README.md')] : []),
  ]
  for (const docPath of publicMarkdown) {
    const source = readFileSync(docPath, 'utf8')
    for (const match of source.matchAll(referencePattern)) {
      const id = match[1].slice(0, -4)
      if (!ids.has(id)) {
        errors.push(`${relative(root, docPath)} references undeclared generated screenshot: ${match[1]}`)
      }
    }
  }

  return errors
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = validateDocumentationScreenshots()
  if (errors.length) {
    for (const error of errors) process.stderr.write(`[docs:screenshots] ${error}\n`)
    process.exitCode = 1
  } else {
    process.stdout.write(`[docs:screenshots] ${DOCUMENTATION_SCREENSHOT_JOURNEYS.length} owned core journeys are referenced exactly once in the generated set.\n`)
  }
}
