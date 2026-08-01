/**
 * Versioned product-surface contract shared by navigation, route guards, tests,
 * and public-claim validation. Runtime discovery remains authoritative for the
 * contents of a workspace; this manifest describes what Open Cowork itself
 * promises to compose.
 */
import type { DesktopFeatureKey } from './app-config.js'

export type ProductSurfaceId =
  | 'home'
  | 'chat'
  | 'projects'
  | 'team'
  | 'playbooks'
  | 'tools'
  | 'settings'
  | 'knowledge'
  | 'approvals'
  | 'channels'
  | 'artifacts'
  | 'voice'

export type ProductSurfaceAvailability = 'always' | 'default-on' | 'default-off'

export type ProductSurfaceManifestEntry = Readonly<{
  id: ProductSurfaceId
  label: string
  route: string | null
  featureKey: DesktopFeatureKey | null
  availability: ProductSurfaceAvailability
  outcome: string
}>

const surfaces = [
  {
    id: 'home',
    label: 'Home',
    route: 'home',
    featureKey: null,
    availability: 'always',
    outcome: 'Start useful work or resume a recent chat.',
  },
  {
    id: 'chat',
    label: 'Chat',
    route: 'chat',
    featureKey: null,
    availability: 'always',
    outcome: 'Work with OpenCode and review its progress, approvals, and outputs.',
  },
  {
    id: 'projects',
    label: 'Projects',
    route: 'projects',
    featureKey: 'projects',
    availability: 'default-on',
    outcome: 'Organize objectives and Kanban tasks, then open their linked work chats.',
  },
  {
    id: 'team',
    label: 'Team',
    route: 'team',
    featureKey: 'team',
    availability: 'default-on',
    outcome: 'Choose or compose reusable OpenCode coworkers for focused work.',
  },
  {
    id: 'playbooks',
    label: 'Playbooks',
    route: 'playbooks',
    featureKey: 'playbooks',
    availability: 'default-on',
    outcome: 'Create, review, and run repeatable work through OpenCode workflows.',
  },
  {
    id: 'tools',
    label: 'Tools & Skills',
    route: 'tools',
    featureKey: 'tools',
    availability: 'default-on',
    outcome: 'Inspect and configure the tools and skills available in this workspace.',
  },
  {
    id: 'settings',
    label: 'Settings',
    route: null,
    featureKey: null,
    availability: 'always',
    outcome: 'Configure models, permissions, appearance, storage, and optional features.',
  },
  {
    id: 'knowledge',
    label: 'Knowledge',
    route: 'knowledge',
    featureKey: 'knowledge',
    availability: 'default-off',
    outcome: 'Propose and review shared in-app knowledge.',
  },
  {
    id: 'approvals',
    label: 'Approvals',
    route: 'approvals',
    featureKey: 'approvals',
    availability: 'default-off',
    outcome: 'Review pending questions and permissions across chats.',
  },
  {
    id: 'channels',
    label: 'Channels',
    route: 'channels',
    featureKey: 'channels',
    availability: 'default-off',
    outcome: 'Inspect configured cloud channel connections and delivery state.',
  },
  {
    id: 'artifacts',
    label: 'Artifacts',
    route: 'artifacts',
    featureKey: 'artifacts',
    availability: 'default-off',
    outcome: 'Browse redaction-safe deliverables across chats.',
  },
  {
    id: 'voice',
    label: 'Voice',
    route: null,
    featureKey: 'voice',
    availability: 'default-off',
    outcome: 'Use private realtime voice on a supported Desktop Local setup.',
  },
] as const satisfies readonly ProductSurfaceManifestEntry[]

export const PRODUCT_CAPABILITY_MANIFEST = Object.freeze({
  version: 1,
  heroPath: ['home', 'chat', 'projects', 'team', 'playbooks', 'tools', 'settings'] as const,
  surfaces,
  projects: Object.freeze({
    provides: ['objectives', 'Kanban tasks', 'linked work chats'] as const,
  }),
  configuredCatalog: Object.freeze({
    tools: 7,
    skills: 6,
    mcpServers: 7,
  }),
})

export function productSurfaceForRoute(route: string): ProductSurfaceManifestEntry | null {
  return PRODUCT_CAPABILITY_MANIFEST.surfaces.find((surface) => surface.route === route) || null
}

export function productFeatureForRoute(route: string): DesktopFeatureKey | null {
  return productSurfaceForRoute(route)?.featureKey || null
}
