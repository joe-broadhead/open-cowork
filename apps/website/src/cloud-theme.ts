import { UI_THEME_PRESETS } from '@open-cowork/shared'
import { escapeHtml } from './html-utils.ts'

export const CLOUD_THEME_STORAGE_KEY = 'open-cowork-cloud-ui-theme'
export const DEFAULT_CLOUD_THEME_PRESET = 'mercury'

export function cloudThemePresetOptions() {
  return Object.entries(UI_THEME_PRESETS).map(([id, preset]) => ({
    id,
    label: preset.label,
    description: preset.description,
    swatches: preset.swatches,
  }))
}

export function cloudThemePresetSelectMarkup(tenantBrandingLocked: boolean) {
  const lockedAttrs = tenantBrandingLocked ? ' disabled title="Theme is managed by this cloud workspace"' : ''
  return `<label class="cloud-theme-switcher">
            <span>Theme</span>
            <select id="cloud-theme-preset" aria-label="Theme preset" data-tenant-branding-locked="${tenantBrandingLocked ? 'true' : 'false'}"${lockedAttrs}>
              ${cloudThemePresetOptions().map((preset) => `<option value="${escapeHtml(preset.id)}"${preset.id === DEFAULT_CLOUD_THEME_PRESET ? ' selected' : ''}>${escapeHtml(preset.label)}</option>`).join('')}
            </select>
          </label>`
}

export function isCloudThemePreset(value: string | null | undefined) {
  return Boolean(value && Object.prototype.hasOwnProperty.call(UI_THEME_PRESETS, value))
}
