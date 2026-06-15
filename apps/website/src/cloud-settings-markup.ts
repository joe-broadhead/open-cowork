import { escapeHtml } from './html-utils.ts'
import { routePanelAttrs, routeParityMarkup } from './route-markup.ts'
import { cloudAccentPresetOptions, cloudDensityOptions, cloudThemePresetOptions } from './cloud-theme.ts'

type CloudSettingsSurfaceInput = {
  tenantBrandingLocked: boolean
  profileName: string
  role: string
  chatEnabled: boolean
  workflowsEnabled: boolean
}

export function cloudSettingsRouteMarkup(input: CloudSettingsSurfaceInput) {
  return `<section ${routePanelAttrs('settings')}>
          <div class="section-header">
            <div>
              <h2>Settings</h2>
              <div class="meta">User preferences for appearance, notifications, privacy, and cloud profile status</div>
            </div>
          </div>
          ${routeParityMarkup('settings')}
          ${cloudSettingsSurfaceMarkup(input)}
        </section>`
}

export function cloudSettingsSurfaceMarkup(input: CloudSettingsSurfaceInput) {
  const locked = input.tenantBrandingLocked
  const lockedAttrs = locked ? ' disabled title="Theme is managed by this cloud workspace"' : ''
  return `<div class="cloud-settings-surface" data-tenant-branding-locked="${locked ? 'true' : 'false'}" aria-label="User settings">
      <div class="settings-grid">
        <nav class="settings-side" aria-label="Settings sections">
          <button type="button" data-cloud-settings-target="cloud-settings-profile">Account</button>
          <button type="button" data-cloud-settings-target="cloud-settings-providers">AI providers</button>
          <button type="button" data-cloud-settings-target="cloud-settings-appearance">Appearance</button>
          <button type="button" data-cloud-settings-target="cloud-settings-notifications">Notifications</button>
          <button type="button" data-cloud-settings-target="cloud-settings-privacy">Privacy</button>
        </nav>
        <div class="settings-main">
          <section class="settings-section" id="cloud-settings-profile">
            <div>
              <h3>Account</h3>
              <p class="meta">Your cloud profile and current workspace role.</p>
            </div>
            <div class="settings-group">
              <div class="settings-row">
                <div><strong>Profile</strong><span>${escapeHtml(input.profileName)}</span></div>
                <span class="pill" data-kind="info">${escapeHtml(input.role)}</span>
              </div>
              <div class="settings-row">
                <div><strong>Workspace access</strong><span>Chat ${input.chatEnabled ? 'enabled' : 'disabled'} · Playbooks ${input.workflowsEnabled ? 'enabled' : 'disabled'}</span></div>
                <span class="pill" data-kind="${input.chatEnabled ? 'ok' : 'warn'}">${input.chatEnabled ? 'Ready' : 'Limited'}</span>
              </div>
            </div>
          </section>

          <section class="settings-section" id="cloud-settings-providers">
            <div>
              <h3>AI providers</h3>
              <p class="meta">Cloud workspaces expose policy-safe provider status here. API keys and BYOK rotation stay in Admin.</p>
            </div>
            <div class="settings-group">
              <div class="settings-row">
                <div><strong>Runtime profile</strong><span>${escapeHtml(input.profileName)} controls available providers, models, and feature gates.</span></div>
                <span class="pill" data-kind="info">Policy managed</span>
              </div>
              <div class="settings-row">
                <div><strong>Provider keys</strong><span>Secrets are write-only in Admin and never rendered in user settings.</span></div>
                <span class="pill">Read-only</span>
              </div>
            </div>
          </section>

          <section class="settings-section" id="cloud-settings-appearance">
            <div>
              <h3>Appearance</h3>
              <p class="meta">Choose the same Studio theme, accent, and density used by Desktop.</p>
            </div>
            <div class="settings-group">
              <div class="settings-row">
                <div><strong>Theme</strong><span>Day or Mercury, plus shared theme presets.</span></div>
                <div class="settings-control-pair">
                  <label><span>Preset</span><select data-cloud-theme-control="preset" data-tenant-branding-locked="${locked ? 'true' : 'false'}"${lockedAttrs}>
                    ${cloudThemePresetOptions().map((preset) => `<option value="${escapeHtml(preset.id)}">${escapeHtml(preset.label)}</option>`).join('')}
                  </select></label>
                  <label><span>Mode</span><select data-cloud-theme-control="scheme" data-tenant-branding-locked="${locked ? 'true' : 'false'}"${lockedAttrs}>
                    <option value="dark">Mercury</option>
                    <option value="light">Day</option>
                  </select></label>
                </div>
              </div>
              <div class="settings-row">
                <div><strong>Accent colour</strong><span>The signature tone across Cloud Web.</span></div>
                <div class="settings-swatches" aria-label="Accent colour">
                  ${cloudAccentPresetOptions().map((preset) => `<button type="button" class="settings-swatch" data-cloud-theme-accent-button="${escapeHtml(preset.id)}" aria-label="${escapeHtml(preset.label)}"${locked ? ' disabled title="Theme is managed by this cloud workspace"' : ''} style="--swatch-a:${escapeHtml(preset.accent)};--swatch-b:${escapeHtml(preset.accent2)}"></button>`).join('')}
                </div>
              </div>
              <div class="settings-row">
                <div><strong>Density</strong><span>Control how much breathing room the app uses.</span></div>
                <div class="settings-segment" role="group" aria-label="Interface density">
                  ${cloudDensityOptions().map((option) => `<button type="button" data-cloud-density-button="${escapeHtml(option.id)}">${escapeHtml(option.label)}</button>`).join('')}
                </div>
              </div>
            </div>
          </section>

          <section class="settings-section" id="cloud-settings-notifications">
            <div>
              <h3>Notifications</h3>
              <p class="meta">These user preferences are separate from Admin channel delivery policy.</p>
            </div>
            <div class="settings-group">
              ${[
                ['voice', 'Voice replies', 'Let coworkers answer out loud when a workflow explicitly asks for voice output.', true],
                ['suggestions', 'Smart suggestions', 'Show launchpad task ideas based on workspace activity.', true],
                ['digest', 'Daily digest', 'A morning summary of completed runs, blocked work, and fresh artifacts.', false],
                ['sound', 'Sounds', 'Play a short chime when important work finishes or needs attention.', true],
              ].map(([key, title, description, enabled]) => settingsToggleMarkup(`cloud-setting-notification-${key}`, title as string, description as string, Boolean(enabled))).join('')}
            </div>
          </section>

          <section class="settings-section" id="cloud-settings-privacy">
            <div>
              <h3>Privacy</h3>
              <p class="meta">User preferences for product-improvement signals and explicit data controls.</p>
            </div>
            <div class="settings-group">
              ${settingsToggleMarkup('cloud-setting-privacy-share', 'Help improve the product', 'Share anonymized usage signals only. Prompts, artifacts, credentials, and local paths are excluded.', false)}
              <div class="settings-row">
                <div><strong>Conversation history</strong><span>Cloud chat retention remains governed by workspace policy until a verified user retention control is available.</span></div>
                <button type="button" disabled>Managed</button>
              </div>
              <div class="settings-row">
                <div><strong>Export everything</strong><span>Data export is handled by the Cloud API and redacts secret internals.</span></div>
                <button type="button" disabled>Export</button>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>`
}

function settingsToggleMarkup(key: string, title: string, description: string, enabled: boolean) {
  return `<div class="settings-row">
      <div><strong>${escapeHtml(title)}</strong><span>${escapeHtml(description)}</span></div>
      <button type="button" class="settings-toggle ${enabled ? 'on' : ''}" role="switch" aria-checked="${enabled ? 'true' : 'false'}" data-cloud-user-setting="${escapeHtml(key)}" data-default-checked="${enabled ? 'true' : 'false'}" aria-label="${escapeHtml(title)}"></button>
    </div>`
}
