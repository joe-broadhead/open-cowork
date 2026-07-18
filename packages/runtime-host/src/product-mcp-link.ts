/**
 * Soft-link helpers for optional Gateway / Wiki MCP entries (JOE-909).
 *
 * Pure builders + CustomMcpConfig conversion. Public builds never pre-enable
 * these MCPs in open-cowork.config.json; Desktop only writes machine-scope
 * custom MCP entries when the user explicitly links.
 */

import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import type { CustomMcpConfig } from '@open-cowork/shared'

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
      /** Ready for saveCustomMcp / custom:add-mcp. */
      customMcp: CustomMcpConfig
      label: string
      description: string
      resolvedBinary: string
    }
  | {
      ok: false
      code: 'binary_missing' | 'unsafe_command' | 'token_file_invalid' | 'unsupported' | 'wiki_root_required'
      message: string
      installHint: string
    }

export type ProductMcpProbe = {
  kind: ProductMcpLinkKind
  name: string
  label: string
  found: boolean
  resolvedBinary?: string
  linked: boolean
  installHint: string
  docsPath: string
}

export const PRODUCT_MCP_LINK_NAMES = {
  gateway: 'cowork-gateway',
  wiki: 'cowork-wiki',
} as const satisfies Record<ProductMcpLinkKind, string>

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

const DOCS_PATHS: Record<ProductMcpLinkKind, string> = {
  gateway: 'docs/opencode-gateway.md',
  wiki: 'docs/openwiki.md',
}

const LABELS: Record<ProductMcpLinkKind, string> = {
  gateway: 'Gateway',
  wiki: 'Wiki',
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
    const command = [resolved, 'mcp']
    const customMcp = toCustomMcpConfig({
      name: PRODUCT_MCP_LINK_NAMES.gateway,
      label: LABELS.gateway,
      description: 'Optional durable work coordinator MCP (user-linked; default off).',
      command,
      environment,
    })
    return {
      ok: true,
      name: PRODUCT_MCP_LINK_NAMES.gateway,
      config: { type: 'local', command, environment },
      customMcp,
      label: LABELS.gateway,
      description: customMcp.description || '',
      resolvedBinary: resolved,
    }
  }

  // Wiki stdio MCP requires an explicit root for a useful local link.
  if (!request.wikiRoot?.trim()) {
    return {
      ok: false,
      code: 'wiki_root_required',
      message: 'Wiki root path is required (the git-backed workspace directory).',
      installHint: INSTALL_HINTS.wiki,
    }
  }
  const wikiRoot = request.wikiRoot.trim()
  const rootUnsafe = assertSafeCommandPath(wikiRoot)
  if (rootUnsafe || !isAbsolute(wikiRoot)) {
    return {
      ok: false,
      code: 'unsafe_command',
      message: rootUnsafe || 'Wiki root must be an absolute path.',
      installHint: INSTALL_HINTS.wiki,
    }
  }

  const environment: Record<string, string> = {}
  if (request.tokenFile) environment.OPENWIKI_TOKEN_FILE = request.tokenFile
  // openwiki [--root <path>] mcp --stdio [--tools proposal]
  const command = [resolved, '--root', wikiRoot, 'mcp', '--stdio', '--tools', 'proposal']
  if (request.tokenFile) {
    command.push('--token-file', request.tokenFile)
  }
  const customMcp = toCustomMcpConfig({
    name: PRODUCT_MCP_LINK_NAMES.wiki,
    label: LABELS.wiki,
    description: 'Optional git-backed Wiki MCP (user-linked; default off).',
    command,
    environment: Object.keys(environment).length ? environment : undefined,
  })
  return {
    ok: true,
    name: PRODUCT_MCP_LINK_NAMES.wiki,
    config: {
      type: 'local',
      command,
      environment: Object.keys(environment).length ? environment : undefined,
    },
    customMcp,
    label: LABELS.wiki,
    description: customMcp.description || '',
    resolvedBinary: resolved,
  }
}

export function toCustomMcpConfig(input: {
  name: string
  label: string
  description: string
  command: string[]
  environment?: Record<string, string>
}): CustomMcpConfig {
  const [bin, ...args] = input.command
  return {
    scope: 'machine',
    directory: null,
    name: input.name,
    label: input.label,
    description: input.description,
    type: 'stdio',
    command: bin,
    args,
    env: input.environment,
    // Soft-linked products start in ask mode; operators may raise later.
    permissionMode: 'ask',
    allowPrivateNetwork: false,
  }
}

/** Probe PATH + linked custom MCP names for the Tools soft-link panel. */
export function probeProductMcpLinks(input: {
  linkedNames: Iterable<string>
  pathEnv?: string
  commandOverrides?: Partial<Record<ProductMcpLinkKind, string>>
}): ProductMcpProbe[] {
  const linked = new Set(input.linkedNames)
  return (['gateway', 'wiki'] as const).map((kind) => {
    const override = input.commandOverrides?.[kind]
    const candidates = override?.trim() ? [override.trim()] : DEFAULT_BINS[kind]
    let resolved: string | undefined
    for (const candidate of candidates) {
      if (assertSafeCommandPath(candidate)) continue
      resolved = resolveBinaryOnPath(candidate, input.pathEnv)
      if (resolved) break
    }
    return {
      kind,
      name: PRODUCT_MCP_LINK_NAMES[kind],
      label: LABELS[kind],
      found: Boolean(resolved),
      resolvedBinary: resolved,
      linked: linked.has(PRODUCT_MCP_LINK_NAMES[kind]),
      installHint: INSTALL_HINTS[kind],
      docsPath: DOCS_PATHS[kind],
    }
  })
}

export function isProductMcpLinkName(name: string): boolean {
  return name === PRODUCT_MCP_LINK_NAMES.gateway || name === PRODUCT_MCP_LINK_NAMES.wiki
}
