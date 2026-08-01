export const FEATURE_VALUE_SURFACES = [
  'projects',
  'playbooks',
  'custom-team',
  'channels',
  'knowledge',
  'artifacts',
  'voice',
  'gateway-wiki-linking',
  'locales',
  'appearance',
] as const

export type FeatureValueSurface = (typeof FEATURE_VALUE_SURFACES)[number]

export const FEATURE_VALUE_STAGES = ['discovered', 'activated', 'repeated'] as const
export type FeatureValueStage = (typeof FEATURE_VALUE_STAGES)[number]

export type FeatureValueEventInput = Readonly<{
  feature: FeatureValueSurface
  stage: FeatureValueStage
}>

export type FeatureValueDefinition = Readonly<{
  outcome: string
  discovery: string
  activation: string
  repeat: string
  denominator: string
  owner: 'desktop' | 'workflows' | 'cloud-gateway' | 'knowledge' | 'product-platform'
  reviewDate: `${number}-${number}-${number}`
}>

/**
 * Product-value contract for optional surfaces. These definitions name user
 * outcomes and stable success seams; they deliberately avoid content, ids,
 * paths, or automatic keep/delete thresholds.
 */
export const FEATURE_VALUE_DEFINITIONS = Object.freeze({
  projects: {
    outcome: 'A user organizes work into an objective and advances a linked task.',
    discovery: 'The Projects board becomes visible to the user.',
    activation: 'A project or task mutation succeeds.',
    repeat: 'A later project or task mutation succeeds on the same installation.',
    denominator: 'Installations that discovered Projects.',
    owner: 'desktop',
    reviewDate: '2026-10-01',
  },
  playbooks: {
    outcome: 'A user runs repeatable work without rebuilding its setup.',
    discovery: 'The Playbooks catalog becomes visible to the user.',
    activation: 'A playbook draft is created or a playbook run starts successfully.',
    repeat: 'A later playbook draft or run succeeds on the same installation.',
    denominator: 'Installations that discovered Playbooks.',
    owner: 'workflows',
    reviewDate: '2026-10-01',
  },
  'custom-team': {
    outcome: 'A user saves a reusable coworker tailored to recurring work.',
    discovery: 'The custom-coworker creation affordance becomes visible.',
    activation: 'A custom coworker is created or updated successfully.',
    repeat: 'A later custom-coworker save succeeds on the same installation.',
    denominator: 'Installations that discovered custom coworker creation.',
    owner: 'desktop',
    reviewDate: '2026-10-01',
  },
  channels: {
    outcome: 'A user connects a channel that can deliver work into Open Cowork.',
    discovery: 'The enabled Channels surface becomes visible.',
    activation: 'A channel binding connects successfully.',
    repeat: 'A later channel connection or delivery retry succeeds on the same installation.',
    denominator: 'Installations that discovered Channels.',
    owner: 'cloud-gateway',
    reviewDate: '2026-10-01',
  },
  knowledge: {
    outcome: 'A team captures or reviews reusable knowledge in the in-app store.',
    discovery: 'The enabled Knowledge surface becomes visible.',
    activation: 'A knowledge space or proposal is created, accepted, or restored successfully.',
    repeat: 'A later knowledge mutation succeeds on the same installation.',
    denominator: 'Installations that discovered Knowledge.',
    owner: 'knowledge',
    reviewDate: '2026-10-01',
  },
  artifacts: {
    outcome: 'A user retrieves a generated deliverable from the cross-chat library.',
    discovery: 'The enabled Artifacts surface becomes visible.',
    activation: 'An artifact is opened, exported, or revealed successfully.',
    repeat: 'A later artifact retrieval succeeds on the same installation.',
    denominator: 'Installations that discovered Artifacts.',
    owner: 'desktop',
    reviewDate: '2026-10-01',
  },
  voice: {
    outcome: 'A user completes private realtime voice setup and starts a local voice session.',
    discovery: 'An eligible Voice control becomes visible.',
    activation: 'A voice session starts successfully.',
    repeat: 'A later voice session starts successfully on the same installation.',
    denominator: 'Installations that discovered an eligible Voice control.',
    owner: 'desktop',
    reviewDate: '2026-10-01',
  },
  'gateway-wiki-linking': {
    outcome: 'A user intentionally links an optional Gateway or Wiki sibling product.',
    discovery: 'The advanced optional-product linker is expanded.',
    activation: 'A Gateway or Wiki link request succeeds.',
    repeat: 'A later optional-product link request succeeds on the same installation.',
    denominator: 'Installations that discovered the optional-product linker.',
    owner: 'product-platform',
    reviewDate: '2026-10-01',
  },
  locales: {
    outcome: 'A user explicitly opts into an experimental non-English locale with its fallback limits disclosed.',
    discovery: 'The language selector becomes visible.',
    activation: 'An explicitly labelled experimental locale is persisted and applied successfully.',
    repeat: 'An experimental locale is explicitly applied again on the same installation.',
    denominator: 'Installations that discovered the language selector.',
    owner: 'product-platform',
    reviewDate: '2026-10-01',
  },
  appearance: {
    outcome: 'A user adopts a retained theme or density variant that improves their workbench.',
    discovery: 'Appearance controls become visible.',
    activation: 'A non-default retained theme or density is applied successfully.',
    repeat: 'A retained appearance variant is applied again on the same installation.',
    denominator: 'Installations that discovered appearance controls.',
    owner: 'product-platform',
    reviewDate: '2026-10-01',
  },
} satisfies Record<FeatureValueSurface, FeatureValueDefinition>)

export const FEATURE_VALUE_DECISION_POLICY = Object.freeze({
  automaticRemoval: false,
  minimumDiscoveryCount: null,
  minimumActivationRate: null,
  minimumRepeatRate: null,
  reason: 'A product owner must approve sample size and thresholds before any keep, improve, or remove enforcement.',
})

const FEATURE_VALUE_SURFACE_SET = new Set<string>(FEATURE_VALUE_SURFACES)
const FEATURE_VALUE_STAGE_SET = new Set<string>(FEATURE_VALUE_STAGES)

export function isFeatureValueSurface(value: unknown): value is FeatureValueSurface {
  return typeof value === 'string' && FEATURE_VALUE_SURFACE_SET.has(value)
}

export function isFeatureValueStage(value: unknown): value is FeatureValueStage {
  return typeof value === 'string' && FEATURE_VALUE_STAGE_SET.has(value)
}

export function isFeatureValueEventInput(value: unknown): value is FeatureValueEventInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  return keys.length === 2
    && keys.includes('feature')
    && keys.includes('stage')
    && isFeatureValueSurface(record.feature)
    && isFeatureValueStage(record.stage)
}

export type FeatureValueReportRow = Readonly<{
  feature: FeatureValueSurface
  discovered: number
  activated: number
  repeated: number
  activationRate: number | null
  repeatRate: number | null
  evidence: 'no-data' | 'partial'
}>

export function summarizeFeatureValueEvents(events: readonly FeatureValueEventInput[]): FeatureValueReportRow[] {
  const counts = new Map(FEATURE_VALUE_SURFACES.map((feature) => [feature, {
    discovered: 0,
    activated: 0,
    repeated: 0,
  }]))
  for (const event of events) counts.get(event.feature)![event.stage] += 1

  return FEATURE_VALUE_SURFACES.map((feature) => {
    const row = counts.get(feature)!
    const activationEvidenceComplete = row.activated <= row.discovered
    const repeatEvidenceComplete = row.repeated <= row.activated
    const hasEvidence = row.discovered > 0 || row.activated > 0 || row.repeated > 0
    return {
      feature,
      ...row,
      activationRate: activationEvidenceComplete && row.discovered > 0
        ? row.activated / row.discovered
        : null,
      repeatRate: repeatEvidenceComplete && row.activated > 0
        ? row.repeated / row.activated
        : null,
      // Anonymous delivery is at-least-once and collector exports do not carry
      // cohort/coverage provenance, so ordered counts are still observations,
      // never proof of a complete installation cohort.
      evidence: hasEvidence ? 'partial' : 'no-data',
    }
  })
}
