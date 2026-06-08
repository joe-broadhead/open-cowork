import { DEFAULT_UI_ACCENT_PRESET_ID, UI_ACCENT_PRESETS, UI_THEME_PRESETS } from '@open-cowork/shared'
import { escapeHtml } from './html-utils.ts'

export const CLOUD_THEME_STORAGE_KEY = 'open-cowork-cloud-ui-theme'
export const CLOUD_THEME_SCHEME_STORAGE_KEY = 'open-cowork-cloud-color-scheme'
export const CLOUD_THEME_ACCENT_STORAGE_KEY = 'open-cowork-cloud-ui-accent'
export const CLOUD_THEME_DENSITY_STORAGE_KEY = 'open-cowork-cloud-density'
export const DEFAULT_CLOUD_THEME_PRESET = 'mercury'
export const DEFAULT_CLOUD_THEME_SCHEME = 'dark'
export const DEFAULT_CLOUD_THEME_ACCENT_PRESET = DEFAULT_UI_ACCENT_PRESET_ID
export const DEFAULT_CLOUD_THEME_DENSITY = 'regular'
export type CloudDensity = 'compact' | 'regular' | 'comfy'

export function cloudThemePresetOptions() {
  return Object.entries(UI_THEME_PRESETS).map(([id, preset]) => ({
    id,
    label: preset.label,
    description: preset.description,
    swatches: preset.swatches,
  }))
}

export function cloudAccentPresetOptions() {
  return Object.entries(UI_ACCENT_PRESETS).map(([id, preset]) => ({
    id,
    label: preset.label,
    accent: preset.accent,
    accent2: preset.accent2,
  }))
}

export function cloudDensityOptions(): Array<{ id: CloudDensity; label: string }> {
  return [
    { id: 'compact', label: 'Compact' },
    { id: 'regular', label: 'Regular' },
    { id: 'comfy', label: 'Comfy' },
  ]
}

export function cloudThemePresetSelectMarkup(tenantBrandingLocked: boolean) {
  const lockedAttrs = tenantBrandingLocked ? ' disabled title="Theme is managed by this cloud workspace"' : ''
  return `<div class="cloud-theme-controls" data-tenant-branding-locked="${tenantBrandingLocked ? 'true' : 'false'}">
          <label class="cloud-theme-switcher">
            <span>Theme</span>
            <select id="cloud-theme-preset" aria-label="Theme preset" data-tenant-branding-locked="${tenantBrandingLocked ? 'true' : 'false'}"${lockedAttrs}>
              ${cloudThemePresetOptions().map((preset) => `<option value="${escapeHtml(preset.id)}"${preset.id === DEFAULT_CLOUD_THEME_PRESET ? ' selected' : ''}>${escapeHtml(preset.label)}</option>`).join('')}
            </select>
          </label>
          <label class="cloud-theme-switcher">
            <span>Mode</span>
            <select id="cloud-theme-scheme" aria-label="Theme mode" data-tenant-branding-locked="${tenantBrandingLocked ? 'true' : 'false'}"${lockedAttrs}>
              <option value="dark" selected>Mercury</option>
              <option value="light">Day</option>
            </select>
          </label>
          <label class="cloud-theme-switcher">
            <span>Accent</span>
            <select id="cloud-theme-accent" aria-label="Accent preset" data-tenant-branding-locked="${tenantBrandingLocked ? 'true' : 'false'}"${lockedAttrs}>
              ${cloudAccentPresetOptions().map((preset) => `<option value="${escapeHtml(preset.id)}"${preset.id === DEFAULT_CLOUD_THEME_ACCENT_PRESET ? ' selected' : ''}>${escapeHtml(preset.label)}</option>`).join('')}
            </select>
          </label>
          <label class="cloud-theme-switcher">
            <span>Density</span>
            <select id="cloud-theme-density" aria-label="Interface density">
              ${cloudDensityOptions().map((option) => `<option value="${escapeHtml(option.id)}"${option.id === DEFAULT_CLOUD_THEME_DENSITY ? ' selected' : ''}>${escapeHtml(option.label)}</option>`).join('')}
            </select>
          </label>
        </div>`
}

export function isCloudThemePreset(value: string | null | undefined) {
  return Boolean(value && Object.prototype.hasOwnProperty.call(UI_THEME_PRESETS, value))
}

export function isCloudThemeScheme(value: string | null | undefined): value is 'dark' | 'light' {
  return value === 'dark' || value === 'light'
}

export function isCloudThemeAccentPreset(value: string | null | undefined) {
  return Boolean(value && Object.prototype.hasOwnProperty.call(UI_ACCENT_PRESETS, value))
}

export function isCloudDensity(value: string | null | undefined): value is CloudDensity {
  return value === 'compact' || value === 'regular' || value === 'comfy'
}
