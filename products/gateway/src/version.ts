import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The single source of the Gateway version: `package.json`, resolved relative to
 * this module (which builds one level below the repo/package root in both `src/`
 * and `dist/`). Every surface that reports a version — the CLI `--version`, the
 * MCP server descriptor — reads it here so none can drift from the package.
 */
export function readPackageVersion(): string {
  try {
    const packageFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
    return JSON.parse(fs.readFileSync(packageFile, 'utf-8')).version || '0.0.0'
  } catch {
    return '0.0.0'
  }
}
