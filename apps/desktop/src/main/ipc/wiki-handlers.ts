import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import { homedir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  WikiConnectRequest,
  WikiConnectTokenRequest,
  WikiDocument,
  WikiGraph,
  WikiGraphNeighbors,
  WikiOverview,
  WikiPageIndexEntry,
  WikiRemoteConnectionSummary,
  WikiSearchResult,
  WikiSourceResult,
  WikiSourceState,
} from '@open-cowork/shared'
import { log } from '@open-cowork/shared/node'
import type { IpcHandlerContext } from './context.ts'
import { noIpcArgs, objectArg, optionalStringArg, registerIpcInvoke, stringArg } from './schema.ts'
import { mapGraphIndex, mapGraphNeighbors, graphNode, graphEdge } from '../wiki/graph-mappers.ts'
import { connectRemoteOAuth, connectRemoteWithToken, remoteWikiStore, RemoteWikiClient } from '../wiki/remote.ts'

const execFileAsync = promisify(execFile)

// The built OpenWiki CLI lives in the monorepo at
// products/wiki/packages/cli/dist/openwiki.js. This resolution mirrors the
// `mcps/wiki` launcher so the UI and the agent-facing MCP serve the same root.
const here = dirname(fileURLToPath(import.meta.url)) // .../desktop/dist/main
const repoRoot = join(here, '..', '..', '..', '..')

function resolveWikiCli(): string {
  const envCli = process.env.OPENWIKI_CLI?.trim()
  if (envCli && existsSync(envCli)) return envCli
  const devCli = join(repoRoot, 'products', 'wiki', 'packages', 'cli', 'dist', 'openwiki.js')
  return existsSync(devCli) ? devCli : ''
}

function resolveWikiRoot(): string {
  const envRoot = process.env.OPEN_WIKI_ROOT?.trim()
  if (envRoot) return envRoot
  // os.userInfo().homedir ignores the app's sandboxed $HOME (like the MCP launcher).
  try { return join(userInfo().homedir, 'Open Wiki') }
  catch { return join(process.env.HOME || homedir() || '', 'Open Wiki') }
}

type SectionInfo = { id: string; title: string; paths: string[]; visibility: string }

async function loadSections(root: string): Promise<SectionInfo[]> {
  try {
    const raw = await readFile(join(root, 'policy', 'sections.json'), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return (parsed as Array<Record<string, unknown>>).map((s) => ({
      id: String(s.id ?? ''),
      title: String(s.title ?? s.id ?? ''),
      paths: Array.isArray(s.paths) ? (s.paths as string[]).map(String) : [],
      visibility: String(s.visibility ?? 'public'),
    }))
  } catch {
    return []
  }
}

function globMatch(sectionPath: string, pagePath: string): boolean {
  if (sectionPath.endsWith('/**')) {
    const prefix = sectionPath.slice(0, -3)
    return pagePath === prefix || pagePath.startsWith(prefix)
  }
  return sectionPath === pagePath
}

function longestPath(s: SectionInfo): number {
  return Math.max(0, ...s.paths.map((entry) => (entry.endsWith('/**') ? entry.length - 3 : entry.length)))
}

function classify(
  sections: SectionInfo[],
  pagePath: string,
): { section: string | null; sectionTitle: string | null; isPrivate: boolean } {
  const hits = sections
    .filter((section) => section.paths.some((entry) => globMatch(entry, pagePath)))
    .sort((a, b) => longestPath(b) - longestPath(a))
  const top = hits[0] ?? null
  return {
    section: top?.id ?? null,
    sectionTitle: top?.title ?? null,
    isPrivate: top?.visibility === 'private',
  }
}

async function runCli(root: string, args: string[], timeoutMs = 30_000):
  Promise<{ ok: boolean; data: unknown; error: string | null }> {
  const cli = resolveWikiCli()
  if (!cli) return { ok: false, data: null, error: 'OpenWiki CLI not found.' }
  try {
    const { stdout } = await execFileAsync('node', [cli, '--root', root, ...args], {
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      encoding: 'utf8',
    })
    const jsonStart = stdout.indexOf('{')
    const body = jsonStart === -1 ? stdout : stdout.slice(jsonStart)
    const parsed = body ? JSON.parse(body) : null
    return { ok: true, data: parsed, error: null }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, data: null, error: message }
  }
}

function toPageEntry(raw: Record<string, unknown>, sections: SectionInfo[]): WikiPageIndexEntry {
  const path = String(raw.path ?? '')
  const c = classify(sections, path)
  return {
    id: String(raw.id ?? ''),
    title: String(raw.title ?? (path || 'Untitled')),
    path,
    section: c.section,
    sectionTitle: c.sectionTitle,
    isPrivate: c.isPrivate,
    summary: String(raw.summary ?? ''),
    topics: Array.isArray(raw.topics) ? (raw.topics as string[]).map(String) : [],
    updatedAt: raw.updated_at ? String(raw.updated_at) : null,
  }
}

function pageList(raw: unknown): Array<Record<string, unknown>> {
  if (!raw || typeof raw !== 'object') return []
  const pages = (raw as Record<string, unknown>).pages
  return Array.isArray(pages) ? (pages as Array<Record<string, unknown>>) : []
}











export function registerWikiHandlers(context: IpcHandlerContext): void {
  registerIpcInvoke(context, 'wiki:overview', noIpcArgs, async (): Promise<WikiOverview> => {
    const creds = await remoteWikiStore.activeCredentials()
    if (creds) {
      const client = new RemoteWikiClient(creds.origin, creds.token)
      try {
        const health = await client.health()
        return {
          status: 'linked',
          root: creds.origin,
          cli: null,
          pageCount: health.pageCount ?? 0,
          error: health.status === 'ok' || health.status === 'degraded' ? null : health.status,
          source: 'remote',
          origin: creds.origin,
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { status: 'unavailable', root: creds.origin, cli: null, pageCount: 0, error: message, source: 'remote', origin: creds.origin }
      }
    }
    const cli = resolveWikiCli()
    const root = resolveWikiRoot()
    if (!cli) {
      return { status: 'no-cli', root, cli: null, pageCount: 0, error: 'OpenWiki CLI not found. Set OPENWIKI_CLI or build products/wiki.', source: 'local', origin: null }
    }
    if (!existsSync(root)) {
      return { status: 'no-root', root, cli, pageCount: 0, error: `Wiki root missing: ${root}`, source: 'local', origin: null }
    }
    if (!existsSync(join(root, 'openwiki.json'))) {
      return { status: 'no-root', root, cli, pageCount: 0, error: `Wiki not initialized at ${root}`, source: 'local', origin: null }
    }
    const res = await runCli(root, ['pages', 'list', '--json'])
    if (!res.ok || !res.data) {
      log('wiki', `pages list failed: ${res.error ?? 'unknown'}`)
      return { status: 'unavailable', root, cli, pageCount: 0, error: res.error ?? 'Failed to list wiki pages.', source: 'local', origin: null }
    }
    return { status: 'linked', root, cli, pageCount: pageList(res.data).length, error: null, source: 'local', origin: null }
  })

  registerIpcInvoke(context, 'wiki:list-pages', noIpcArgs, async (): Promise<WikiPageIndexEntry[]> => {
    const creds = await remoteWikiStore.activeCredentials()
    if (creds) {
      try {
        return await new RemoteWikiClient(creds.origin, creds.token).listPages()
      } catch (err) {
        log('wiki', `remote list-pages failed: ${err instanceof Error ? err.message : String(err)}`)
        return []
      }
    }
    const root = resolveWikiRoot()
    const sections = await loadSections(root)
    const res = await runCli(root, ['pages', 'list', '--json'])
    if (!res.ok || !res.data) return []
    return pageList(res.data).map((page) => toPageEntry(page, sections))
  })

  registerIpcInvoke(
    context,
    'wiki:read-page',
    stringArg('wiki page id'),
    async (_event, id): Promise<WikiDocument | null> => {
      if (!id.trim()) return null
      const creds = await remoteWikiStore.activeCredentials()
      if (creds) {
        try {
          return await new RemoteWikiClient(creds.origin, creds.token).readPage(id.trim())
        } catch (err) {
          log('warn', `remote read-page failed: ${err instanceof Error ? err.message : String(err)}`)
          return null
        }
      }
      const root = resolveWikiRoot()
      const sections = await loadSections(root)
      const res = await runCli(root, ['page', 'read', id.trim(), '--json'])
      if (!res.ok || !res.data) return null
      const raw = res.data as Record<string, unknown>
      const path = String(raw.path ?? '')
      const c = classify(sections, path)
      return {
        id: String(raw.id ?? id),
        title: String(raw.title ?? (path || id)),
        path,
        section: c.section,
        sectionTitle: c.sectionTitle,
        isPrivate: c.isPrivate,
        bodyMarkdown: String(raw.body ?? ''),
        summary: String(raw.summary ?? ''),
        status: String(raw.status ?? ''),
        updatedAt: raw.updated_at ? String(raw.updated_at) : null,
      }
    },
  )

  registerIpcInvoke(
    context,
    'wiki:search',
    stringArg('wiki search query'),
    async (_event, query: string): Promise<WikiSearchResult[]> => {
      if (!query.trim()) return []
      const creds = await remoteWikiStore.activeCredentials()
      if (creds) {
        try {
          return await new RemoteWikiClient(creds.origin, creds.token).search(query.trim())
        } catch (err) {
          log('warn', `remote search failed: ${err instanceof Error ? err.message : String(err)}`)
          return []
        }
      }
      const root = resolveWikiRoot()
      const sections = await loadSections(root)
      const res = await runCli(root, ['search', query.trim(), '--json', '--limit', '50'])
      if (!res.ok || !res.data) return []
      const results = (res.data as Record<string, unknown>).results
      if (!Array.isArray(results)) return []
      return (results as Array<Record<string, unknown>>)
        .filter((r) => String(r.type ?? '') === 'page')
        .map((r) => {
          const path = String(r.path ?? '')
          const c = classify(sections, path)
          return {
            id: String(r.id ?? ''),
            title: String(r.title ?? ''),
            path,
            snippet: String(r.summary ?? ''),
            isPrivate: c.isPrivate,
          }
        })
    },
  )

  registerIpcInvoke(context, 'wiki:graph', noIpcArgs, async (): Promise<WikiGraph> => {
    const creds = await remoteWikiStore.activeCredentials()
    if (creds) {
      try {
        return await new RemoteWikiClient(creds.origin, creds.token).graph()
      } catch (err) {
        log('warn', `remote graph failed: ${err instanceof Error ? err.message : String(err)}`)
        return { nodes: [], edges: [] }
      }
    }
    const root = resolveWikiRoot()
    const res = await runCli(root, ['graph', 'edges', '--json'])
    if (!res.ok || !res.data) return { nodes: [], edges: [] }
    return mapGraphIndex(res.data)
  })

  registerIpcInvoke(
    context,
    'wiki:graph-neighbors',
    stringArg('wiki page id'),
    async (_event, id: string): Promise<WikiGraphNeighbors | null> => {
      if (!id.trim()) return null
      const creds = await remoteWikiStore.activeCredentials()
      if (creds) {
        try {
          return await new RemoteWikiClient(creds.origin, creds.token).graphNeighbors(id.trim())
        } catch (err) {
          log('warn', `remote graph-neighbors failed: ${err instanceof Error ? err.message : String(err)}`)
          return null
        }
      }
      const root = resolveWikiRoot()
      const res = await runCli(root, ['graph', 'neighbors', id.trim(), '--json'])
      if (!res.ok || !res.data) return null
      return mapGraphNeighbors(res.data)
    },
  )

  registerIpcInvoke(context, 'wiki:source-get', noIpcArgs, async (): Promise<WikiSourceState> => {
    return remoteWikiStore.sourceState()
  })

  registerIpcInvoke(context, 'wiki:remote-list', noIpcArgs, async (): Promise<WikiRemoteConnectionSummary[]> => {
    return remoteWikiStore.summaries()
  })

  registerIpcInvoke(context, 'wiki:remote-set-active', optionalStringArg('wiki connection id'), async (_event, connectionId: string | null | undefined): Promise<WikiSourceResult> => {
    return remoteWikiStore.setActive(connectionId?.trim() ? connectionId.trim() : null)
  })

  registerIpcInvoke(context, 'wiki:remote-remove', stringArg('wiki connection id'), async (_event, id: string): Promise<WikiSourceResult> => {
    return remoteWikiStore.remove(id.trim())
  })

  registerIpcInvoke(
    context,
    'wiki:remote-connect',
    objectArg<WikiConnectRequest>('wiki connect request'),
    async (_event, request: WikiConnectRequest): Promise<WikiSourceResult> => {
      return connectRemoteOAuth(request)
    },
  )

  registerIpcInvoke(
    context,
    'wiki:remote-connect-token',
    objectArg<WikiConnectTokenRequest>('wiki token connect request'),
    async (_event, request: WikiConnectTokenRequest): Promise<WikiSourceResult> => {
      return connectRemoteWithToken(request)
    },
  )
}
