import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { execFileSync } from 'child_process'

export interface CoworkSettings {
  gcpProjectId: string | null
  gcpRegion: string
  vertexModel: string
}

const DEFAULTS: CoworkSettings = {
  gcpProjectId: null,
  gcpRegion: 'global',
  vertexModel: 'google/gemini-2.5-pro',
}

function getSettingsPath() {
  const dir = join(app.getPath('userData'), 'cowork')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'settings.json')
}

export function loadSettings(): CoworkSettings {
  const path = getSettingsPath()
  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, 'utf-8')
      return { ...DEFAULTS, ...JSON.parse(raw) }
    } catch {
      return { ...DEFAULTS }
    }
  }
  return { ...DEFAULTS }
}

export function saveSettings(settings: Partial<CoworkSettings>) {
  const current = loadSettings()
  const merged = { ...current, ...settings }
  writeFileSync(getSettingsPath(), JSON.stringify(merged, null, 2))
  return merged
}

/**
 * Auto-detect GCP project ID from gcloud CLI.
 * Returns null if gcloud isn't available or no project is set.
 */
export function detectGcpProject(): string | null {
  try {
    const result = execFileSync('gcloud', ['config', 'get-value', 'project'], {
      timeout: 5_000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
    return result && result !== '(unset)' ? result : null
  } catch {
    return null
  }
}

/**
 * Auto-detect GCP region from gcloud CLI.
 * Falls back to us-central1 if not set.
 */
export function detectGcpRegion(): string {
  try {
    const result = execFileSync('gcloud', ['config', 'get-value', 'compute/region'], {
      timeout: 5_000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
    return result && result !== '(unset)' ? result : DEFAULTS.gcpRegion
  } catch {
    return DEFAULTS.gcpRegion
  }
}

/**
 * Get the effective settings — uses saved values if present,
 * otherwise auto-detects from gcloud.
 */
export function getEffectiveSettings(): CoworkSettings {
  const saved = loadSettings()
  return {
    gcpProjectId: saved.gcpProjectId || detectGcpProject(),
    gcpRegion: saved.gcpRegion || detectGcpRegion(),
    vertexModel: saved.vertexModel || DEFAULTS.vertexModel,
  }
}

/**
 * Build the Vertex AI base URL from project and region.
 */
export function getVertexBaseUrl(projectId: string, region: string): string {
  return `https://${region}-aiplatform.googleapis.com/v1beta1/projects/${projectId}/locations/${region}/endpoints/openapi`
}
