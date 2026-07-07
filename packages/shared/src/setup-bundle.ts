// Shareable setup export/import bundle.
//
// A portable, versioned JSON document that packages a deployment's installed
// skills + custom MCP servers + custom agents as unified extension descriptors
// (`extension-descriptor.ts`), with every secret redacted. A teammate imports
// the bundle to reproduce the same setup; the import machinery reuses the
// existing per-type install code and never overwrites a secret it can't
// supply.
//
// This module is pure and browser-safe. It owns the bundle format, validation,
// and the import *plan* (which items apply / need a secret / conflict). The
// runtime-host store (`setup-bundle-store.ts`) does the actual IO by reusing
// the descriptor converters plus the existing custom-* stores.

import {
  EXTENSION_DESCRIPTOR_SCHEMA_VERSION,
  unsatisfiedSecrets,
  type ExtensionDescriptor,
  type ExtensionKind,
  type ExtensionSecretRequirement,
} from './extension-descriptor.js'

export const SETUP_BUNDLE_FORMAT = 'open-cowork-setup-bundle' as const
export const SETUP_BUNDLE_VERSION = 1 as const

export interface SetupBundle {
  format: typeof SETUP_BUNDLE_FORMAT
  version: typeof SETUP_BUNDLE_VERSION
  exportedAt: string
  exportedBy?: string
  skills: ExtensionDescriptor[]
  mcps: ExtensionDescriptor[]
  agents: ExtensionDescriptor[]
}

export function buildSetupBundle(input: {
  skills: ExtensionDescriptor[]
  mcps: ExtensionDescriptor[]
  agents: ExtensionDescriptor[]
  now?: string
  exportedBy?: string
}): SetupBundle {
  return {
    format: SETUP_BUNDLE_FORMAT,
    version: SETUP_BUNDLE_VERSION,
    exportedAt: input.now || new Date().toISOString(),
    ...(input.exportedBy ? { exportedBy: input.exportedBy } : {}),
    skills: input.skills,
    mcps: input.mcps,
    agents: input.agents,
  }
}

export function stringifySetupBundle(bundle: SetupBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface SetupBundleValidationSuccess {
  ok: true
  bundle: SetupBundle
}
export interface SetupBundleValidationFailure {
  ok: false
  error: string
}
export type SetupBundleValidation = SetupBundleValidationSuccess | SetupBundleValidationFailure

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function validateDescriptor(raw: unknown, kind: ExtensionKind): ExtensionDescriptor | null {
  if (!isRecord(raw)) return null
  if (raw.schemaVersion !== EXTENSION_DESCRIPTOR_SCHEMA_VERSION) return null
  if (raw.kind !== kind) return null
  if (typeof raw.id !== 'string' || !raw.id.trim()) return null
  if (typeof raw.name !== 'string' || !raw.name.trim()) return null
  if (!isRecord(raw.source)) return null
  if (!Array.isArray(raw.secrets)) return null
  if (!Array.isArray(raw.setup)) return null
  if (!isRecord(raw.payload) || raw.payload.kind !== kind) return null
  return raw as unknown as ExtensionDescriptor
}

function validateDescriptorArray(raw: unknown, kind: ExtensionKind): ExtensionDescriptor[] | null {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) return null
  const out: ExtensionDescriptor[] = []
  for (const entry of raw) {
    const descriptor = validateDescriptor(entry, kind)
    if (!descriptor) return null
    out.push(descriptor)
  }
  return out
}

// Parse + shape-check an untrusted bundle. Returns a tagged union so callers
// surface a human-readable reason.
export function validateSetupBundle(raw: unknown): SetupBundleValidation {
  if (!isRecord(raw)) {
    return { ok: false, error: 'File is not a valid setup bundle (expected a JSON object).' }
  }
  if (raw.format !== SETUP_BUNDLE_FORMAT) {
    return { ok: false, error: `Unsupported bundle format "${String(raw.format)}". Expected "${SETUP_BUNDLE_FORMAT}".` }
  }
  if (raw.version !== SETUP_BUNDLE_VERSION) {
    return { ok: false, error: `Unsupported setup bundle version "${String(raw.version)}". This app supports version ${SETUP_BUNDLE_VERSION}.` }
  }
  if (typeof raw.exportedAt !== 'string' || !raw.exportedAt.trim()) {
    return { ok: false, error: 'Setup bundle is missing a valid "exportedAt" timestamp.' }
  }
  const skills = validateDescriptorArray(raw.skills, 'skill')
  if (!skills) return { ok: false, error: 'Setup bundle "skills" is malformed.' }
  const mcps = validateDescriptorArray(raw.mcps, 'mcp')
  if (!mcps) return { ok: false, error: 'Setup bundle "mcps" is malformed.' }
  const agents = validateDescriptorArray(raw.agents, 'agent')
  if (!agents) return { ok: false, error: 'Setup bundle "agents" is malformed.' }

  return {
    ok: true,
    bundle: {
      format: SETUP_BUNDLE_FORMAT,
      version: SETUP_BUNDLE_VERSION,
      exportedAt: raw.exportedAt,
      ...(typeof raw.exportedBy === 'string' ? { exportedBy: raw.exportedBy } : {}),
      skills,
      mcps,
      agents,
    },
  }
}

// ---------------------------------------------------------------------------
// Import planning
// ---------------------------------------------------------------------------

export type SetupBundleItemStatus = 'applied' | 'needs-secret' | 'skipped-conflict' | 'skipped-unsupported'

export interface SetupBundleImportItemPlan {
  kind: ExtensionKind
  id: string
  name: string
  status: SetupBundleItemStatus
  detail: string
  missingSecrets: ExtensionSecretRequirement[]
}

export interface SetupBundleImportPlan {
  version: number
  items: SetupBundleImportItemPlan[]
}

// Existing installed names, per kind, on the importing machine. Used to detect
// conflicts so import is idempotent (re-importing is a no-op).
export interface SetupBundleExistingNames {
  skills: string[]
  mcps: string[]
  agents: string[]
}

export interface SetupBundlePlanOptions {
  existing: SetupBundleExistingNames
  // descriptor.id -> { secretKey -> value }. Supplies redacted secrets so an
  // item that would otherwise be "needs-secret" can apply.
  secretValues?: Record<string, Record<string, string>>
  // When true, an item whose name already exists is re-applied instead of
  // reported as a conflict. Defaults to false — import never overwrites.
  overwrite?: boolean
}

function planItem(
  descriptor: ExtensionDescriptor,
  existingNames: Set<string>,
  options: SetupBundlePlanOptions,
): SetupBundleImportItemPlan {
  const base = { kind: descriptor.kind, id: descriptor.id, name: descriptor.name }
  const secretValues = options.secretValues?.[descriptor.id] || {}
  const missingSecrets = unsatisfiedSecrets(descriptor, secretValues)

  if (existingNames.has(descriptor.name) && !options.overwrite) {
    return {
      ...base,
      status: 'skipped-conflict',
      detail: `A ${descriptor.kind} named "${descriptor.name}" already exists; left unchanged.`,
      missingSecrets: [],
    }
  }

  if (missingSecrets.length > 0) {
    return {
      ...base,
      status: 'needs-secret',
      detail: `Needs ${missingSecrets.length} secret value(s) before it can be installed.`,
      missingSecrets,
    }
  }

  return {
    ...base,
    status: 'applied',
    detail: existingNames.has(descriptor.name)
      ? `Overwrote existing ${descriptor.kind} "${descriptor.name}".`
      : `Installed ${descriptor.kind} "${descriptor.name}".`,
    missingSecrets: [],
  }
}

// Decide, without any IO, what each bundle item's outcome should be. The store
// executes only the `applied` items; the rest are reported back so the UI can
// prompt for secrets or explain conflicts.
export function planSetupBundleImport(
  bundle: SetupBundle,
  options: SetupBundlePlanOptions,
): SetupBundleImportPlan {
  const skillNames = new Set(options.existing.skills)
  const mcpNames = new Set(options.existing.mcps)
  const agentNames = new Set(options.existing.agents)

  const items: SetupBundleImportItemPlan[] = [
    ...bundle.mcps.map((descriptor) => planItem(descriptor, mcpNames, options)),
    ...bundle.skills.map((descriptor) => planItem(descriptor, skillNames, options)),
    ...bundle.agents.map((descriptor) => planItem(descriptor, agentNames, options)),
  ]

  return { version: bundle.version, items }
}

// Wire-safe options for the `custom.importSetupBundle` CoworkAPI method. The
// runtime-host store maps this onto its richer internal options.
export interface SetupBundleImportOptions {
  workspaceId?: string
  target?: { scope: 'machine' | 'project'; directory?: string | null }
  secretValues?: Record<string, Record<string, string>>
  overwrite?: boolean
}

export interface SetupBundleImportResult {
  version: number
  appliedCount: number
  needsSecretCount: number
  skippedCount: number
  items: SetupBundleImportItemPlan[]
}

export function summarizeImportItems(
  version: number,
  items: SetupBundleImportItemPlan[],
): SetupBundleImportResult {
  return {
    version,
    appliedCount: items.filter((item) => item.status === 'applied').length,
    needsSecretCount: items.filter((item) => item.status === 'needs-secret').length,
    skippedCount: items.filter((item) => item.status === 'skipped-conflict' || item.status === 'skipped-unsupported').length,
    items,
  }
}
