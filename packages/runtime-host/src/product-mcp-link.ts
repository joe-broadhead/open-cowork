/**
 * Soft-link helpers for optional Gateway / Wiki MCP entries (JOE-909).
 *
 * Pure builders only: Desktop Settings may call these later. Public builds
 * never pre-enable these MCPs in open-cowork.config.json.
 */

import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

export type ProductMcpLinkKind = 'gateway' | 'wiki'

export type ProductMcpLinkRequest = {
  kind: ProductMcpLinkKind
  /** Absolute path to binary, or bare bin name resolved from PATH. */
  command?: string
  /** Optional daemon URL for Gateway. */
  gatewayDaemonUrl?: string
  /** Optional owner-only token file path (must not be embedded secrets). */
  tokenFile?: string
  /** Wiki root / workspace path when applicable. */
  wikiRoot?: string
  /** PATH override for tests. */
  pathEnv?: string
}

export type ProductMcpLinkResult =
  | {
      ok: true
      name: string
      config: {
        type: 'local'
        command: string[]
        environment?: Record<string, string>
      }
      label: string
      description: string
    }
  | {
      ok: false
      code: 'binary_missing' | 'unsafe_command' | 'token_file_invalid' | 'unsupported'
      message: string
      installHint: string
    }

const DEFAULT_BINS: Record<ProductMcpLinkKind, string[]> = {
  gateway: ['cowork-gateway', 'opencode-gateway'],
  wiki: ['cowork-wiki', 'openwiki'],
}

const INSTALL_HINTS: Record<ProductMcpLinkKind, string> = {
  gateway:
    'Install Gateway standalone (`cowork-gateway`), then retry. See docs/opencode-gateway.md.',
  wiki:
    'Install Wiki standalone (`cowork-wiki` / `openwiki`), then retry. See docs/openwiki.md.',
}

/** Reject shell metacharacters and relative traversal in command fields. */
export function assertSafeCommandPath(command: string): string | undefined {
  const value = command.trim()
  if (!value) return 'Command is empty.'
  if (/[\n\r\0;|&$`<>]/.test(value)) return 'Command contains unsafe shell metacharacters.'
  if (value.includes('..')) return 'Command path must not contain "..".'
  return undefined
}

export function resolveBinaryOnPath(binName: string, pathEnv = process.env.PATH || ''): string | undefined {
  if (isAbsolute(binName)) {
    try {
      accessSync(binName, constants.X_OK)
      return binName
    } catch {
      return undefined
    }
  }
  for (const dir of pathEnv.split(delimiter).filter(Boolean)) {
    const candidate = join(dir, binName)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // continue
    }
  }
  return undefined
}

export function validateOwnerOnlyTokenFile(tokenFile: string): string | undefined {
  try {
    const st = statSync(tokenFile)
    if (!st.isFile()) return 'Token path is not a regular file.'
    // Owner-only: no group/other read/write/execute (best-effort on non-POSIX).
    const mode = st.mode & 0o777
    if ((mode & 0o077) !== 0) {
      return `Token file must be owner-only (mode & 0o077 === 0); found ${mode.toString(8)}.`
    }
    return undefined
  } catch {
    return 'Token file is missing or unreadable.'
  }
}

/**
 * Build a custom MCP config for Gateway or Wiki. Does not write config —
 * callers pass the result into the custom MCP store when the user opts in.
 */
export function buildProductMcpLink(request: ProductMcpLinkRequest): ProductMcpLinkResult {
  const kind = request.kind
  const candidates = request.command?.trim()
    ? [request.command.trim()]
    : DEFAULT_BINS[kind]

  let resolved: string | undefined
  for (const candidate of candidates) {
    const unsafe = assertSafeCommandPath(candidate)
    if (unsafe) {
      return {
        ok: false,
        code: 'unsafe_command',
        message: unsafe,
        installHint: INSTALL_HINTS[kind],
      }
    }
    resolved = resolveBinaryOnPath(candidate, request.pathEnv)
    if (resolved) break
  }

  if (!resolved) {
    return {
      ok: false,
      code: 'binary_missing',
      message: `Could not find ${DEFAULT_BINS[kind].join(' or ')} on PATH.`,
      installHint: INSTALL_HINTS[kind],
    }
  }

  if (request.tokenFile) {
    const tokenError = validateOwnerOnlyTokenFile(request.tokenFile)
    if (tokenError) {
      return {
        ok: false,
        code: 'token_file_invalid',
        message: tokenError,
        installHint: INSTALL_HINTS[kind],
      }
    }
  }

  if (kind === 'gateway') {
    const environment: Record<string, string> = {
      GATEWAY_DAEMON_URL: request.gatewayDaemonUrl || 'http://127.0.0.1:4097',
      GATEWAY_MCP_TOOLS: 'operate',
    }
    if (request.tokenFile) {
      environment.OPENCODE_GATEWAY_HTTP_READ_TOKEN_FILE = request.tokenFile
    }
    return {
      ok: true,
      name: 'cowork-gateway',
      config: {
        type: 'local',
        command: [resolved, 'mcp'],
        environment,
      },
      label: 'Gateway',
      description: 'Optional durable work coordinator MCP (user-linked; default off).',
    }
  }

  // wiki
  const environment: Record<string, string> = {}
  if (request.wikiRoot) environment.OPENWIKI_ROOT = request.wikiRoot
  if (request.tokenFile) environment.OPENWIKI_TOKEN_FILE = request.tokenFile
  return {
    ok: true,
    name: 'cowork-wiki',
    config: {
      type: 'local',
      command: [resolved, 'mcp', 'serve', ...(request.wikiRoot ? ['--root', request.wikiRoot] : [])],
      environment: Object.keys(environment).length ? environment : undefined,
    },
    label: 'Wiki',
    description: 'Optional git-backed Wiki MCP (user-linked; default off).',
  }
}
