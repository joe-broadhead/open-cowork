#!/usr/bin/env node
/**
 * OpenWiki MCP launcher for Open Cowork.
 *
 * The OpenWiki MCP server ships as the standalone `openwiki` CLI. Its stdio
 * transport is NEWLINE-DELIMITED JSON-RPC (one JSON-RPC message per line),
 * which is exactly the protocol Open Code's stdio MCP client speaks — so there
 * is NO framing translation needed. This package only resolves the built CLI
 * entry, the wiki root, and the tool mode, then spawns the CLI as a child with
 * stdio wired straight through (pass-through). Register it as a local MCP:
 *
 *   { "type":"local", "command":["node","<this entry>"], ... }
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url)) // .../mcps/wiki/dist
const repoRoot = resolve(here, '..', '..', '..')

function resolveWikiCli(): string {
  const envCli = process.env.OPENWIKI_CLI?.trim()
  if (envCli && existsSync(envCli)) return envCli
  const devCli = join(repoRoot, 'products', 'wiki', 'packages', 'cli', 'dist', 'openwiki.js')
  if (existsSync(devCli)) return devCli
  return ''
}

function resolveWikiRoot(): string {
  const envRoot = process.env.OPEN_WIKI_ROOT?.trim()
  if (envRoot) return envRoot
  // Use the OS user-database home (os.userInfo().homedir), which ignores the
  // $HOME env var. The app runs its OpenCode runtime under a sandboxed $HOME
  // (e.g. .../Library/Application), so ~/ would point at the wrong directory.
  try { return join(userInfo().homedir, 'Open Wiki') }
  catch { return join(process.env.HOME || '', 'Open Wiki') }
}

function resolveToolMode(): string {
  return process.env.OPEN_WIKI_TOOLS?.trim() || 'proposal'
}

const wikiCli = resolveWikiCli()
if (!wikiCli) {
  process.stderr.write('[wiki mcp] OpenWiki CLI not found. Set OPENWIKI_CLI to the built openwiki entry.\n')
  process.exit(1)
}
const wikiRoot = resolveWikiRoot()
if (!existsSync(join(wikiRoot, 'openwiki.json'))) {
  process.stderr.write(`[wiki mcp] OpenWiki root not initialized at ${wikiRoot}. Run: openwiki init --template team-wiki "${wikiRoot}"\n`)
  process.exit(1)
}

const child = spawn(
  process.execPath,
  [wikiCli, '--root', wikiRoot, 'mcp', '--stdio', '--tools', resolveToolMode()],
  { stdio: ['inherit', 'inherit', 'inherit'] },
)
child.on('error', (error) => {
  process.stderr.write(`[wiki mcp] failed to start OpenWiki MCP: ${error.message}\n`)
  process.exit(1)
})
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)))
process.on('SIGTERM', () => { child.kill('SIGTERM') })
process.on('SIGINT', () => { child.kill('SIGINT') })
