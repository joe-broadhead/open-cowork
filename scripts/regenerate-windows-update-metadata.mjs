import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'

// When Windows installers are signed AFTER packaging (e.g. SignPath
// Foundation cloud signing), electron-builder's latest.yml still carries
// the sha512/size of the UNSIGNED binary, and the *.blockmap is stale.
// electron-updater would then reject the signed download. This script
// recomputes the sha512 (base64) and size for each referenced installer,
// drops the now-invalid blockMapSize entries, and deletes stale *.blockmap
// files so electron-updater falls back to a verified full download.
//
// It is a no-op when there is no latest.yml (native-certificate signing
// during packaging already keeps the metadata consistent).

export function sha512Base64(filePath) {
  return createHash('sha512').update(readFileSync(filePath)).digest('base64')
}

function referencedFileName(line) {
  const url = /^\s*-?\s*url:\s*(.+?)\s*$/.exec(line)
  if (url) return url[1].replace(/^['"]|['"]$/g, '')
  const path = /^path:\s*(.+?)\s*$/.exec(line)
  if (path) return path[1].replace(/^['"]|['"]$/g, '')
  return null
}

export function regenerateWindowsUpdateMetadataText(yamlText, resolveFile) {
  const lines = yamlText.split('\n')
  let currentFile = null
  const out = []
  for (const line of lines) {
    const referenced = referencedFileName(line)
    if (referenced) {
      currentFile = referenced
      out.push(line)
      continue
    }
    if (/^\s*blockMapSize:\s*/.test(line)) {
      // Drop stale differential-update metadata.
      continue
    }
    const resolved = currentFile ? resolveFile(currentFile) : null
    if (resolved && /^(\s*)sha512:\s*/.test(line)) {
      const indent = line.match(/^(\s*)/)[1]
      out.push(`${indent}sha512: ${resolved.sha512}`)
      continue
    }
    if (resolved && /^(\s*)size:\s*/.test(line)) {
      const indent = line.match(/^(\s*)/)[1]
      out.push(`${indent}size: ${resolved.size}`)
      continue
    }
    out.push(line)
  }
  return out.join('\n')
}

export function regenerateWindowsUpdateMetadata({ dir, yamlName = 'latest.yml' } = {}) {
  const yamlPath = join(dir, yamlName)
  if (!existsSync(yamlPath)) {
    return { updated: false, yamlPath, removedBlockmaps: [] }
  }
  const cache = new Map()
  const resolveFile = (name) => {
    const safeName = basename(name)
    if (cache.has(safeName)) return cache.get(safeName)
    const filePath = join(dir, safeName)
    const resolved = existsSync(filePath) && statSync(filePath).isFile()
      ? { sha512: sha512Base64(filePath), size: statSync(filePath).size }
      : null
    cache.set(safeName, resolved)
    return resolved
  }

  const original = readFileSync(yamlPath, 'utf8')
  const rewritten = regenerateWindowsUpdateMetadataText(original, resolveFile)
  writeFileSync(yamlPath, rewritten)

  const removedBlockmaps = []
  for (const entry of readdirSync(dir)) {
    if (entry.endsWith('.blockmap')) {
      rmSync(join(dir, entry), { force: true })
      removedBlockmaps.push(entry)
    }
  }
  return { updated: true, yamlPath, removedBlockmaps }
}

function main(argv = process.argv.slice(2)) {
  const dirIndex = argv.indexOf('--dir')
  const dir = dirIndex >= 0 ? argv[dirIndex + 1] : 'apps/desktop/release'
  const result = regenerateWindowsUpdateMetadata({ dir })
  if (!result.updated) {
    process.stdout.write(`[windows-update-metadata] no latest.yml in ${dir}; nothing to regenerate\n`)
    return
  }
  process.stdout.write(
    `[windows-update-metadata] rewrote ${result.yamlPath}; removed stale blockmaps: ${result.removedBlockmaps.join(', ') || 'none'}\n`,
  )
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error) {
    console.error(`[windows-update-metadata] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
