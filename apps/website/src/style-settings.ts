export function cloudWebsiteSettingsStyles() {
  return String.raw`
    .cloud-settings-surface {
      display: grid;
      gap: var(--gap);
      min-width: 0;
    }
    .settings-grid {
      display: grid;
      grid-template-columns: minmax(160px, 220px) minmax(0, 1fr);
      gap: var(--gap);
      align-items: start;
      min-width: 0;
    }
    .settings-side {
      position: sticky;
      top: var(--space-4);
      display: grid;
      gap: var(--space-1);
      border: var(--border-width-1) solid var(--color-border-subtle);
      border-radius: var(--radius-lg);
      background: color-mix(in srgb, var(--color-surface) 88%, transparent);
      padding: var(--space-2);
    }
    .settings-side button {
      min-height: var(--control-h-sm);
      border-color: transparent;
      border-radius: var(--radius-sm);
      background: transparent;
      color: var(--muted);
      font-size: var(--text-sm);
      font-weight: 650;
      padding: var(--space-2) var(--space-3);
      text-align: left;
    }
    .settings-side button:hover,
    .settings-side button:focus-visible {
      background: var(--color-surface-hover);
      color: var(--text);
    }
    .settings-main,
    .settings-section,
    .settings-group {
      display: grid;
      gap: var(--gap);
      min-width: 0;
    }
    .settings-section {
      border: var(--border-width-1) solid var(--color-border);
      border-radius: var(--radius-lg);
      background: color-mix(in srgb, var(--color-elevated) 88%, var(--color-base) 12%);
      padding: calc(var(--row-pad) + var(--space-2));
      box-shadow: var(--shadow-2), var(--specular);
    }
    .settings-section h3 {
      margin: 0;
      font-family: var(--font-display);
      font-size: var(--text-md);
      line-height: var(--lh-md);
    }
    .settings-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: var(--gap);
      align-items: center;
      border: var(--border-width-1) solid var(--color-border-subtle);
      border-radius: var(--radius-sm);
      background: color-mix(in srgb, var(--color-surface) 78%, transparent);
      padding: var(--row-pad);
      min-width: 0;
    }
    .settings-row > div:first-child {
      display: grid;
      gap: var(--space-1);
      min-width: 0;
    }
    .settings-row strong {
      color: var(--text);
      font-size: var(--text-sm);
      line-height: var(--lh-sm);
    }
    .settings-row span {
      color: var(--muted);
      font-size: var(--text-xs);
      line-height: var(--lh-xs);
    }
    .settings-control-pair {
      display: grid;
      grid-template-columns: repeat(2, minmax(120px, 1fr));
      gap: var(--space-2);
      min-width: 260px;
    }
    .settings-swatches,
    .settings-segment {
      display: inline-flex;
      align-items: center;
      justify-content: flex-end;
      gap: var(--space-2);
      flex-wrap: wrap;
    }
    .settings-swatch {
      width: 28px;
      height: 28px;
      min-height: 28px;
      border: var(--border-width-1) solid var(--color-border);
      border-radius: var(--radius-full);
      background: linear-gradient(150deg, var(--swatch-b), var(--swatch-a));
      padding: 0;
    }
    .settings-swatch.on,
    .settings-swatch[aria-pressed="true"] {
      border-color: var(--accent);
      box-shadow: var(--ring-selected);
    }
    .settings-segment {
      border: var(--border-width-1) solid var(--color-border-subtle);
      border-radius: var(--radius-sm);
      background: var(--color-surface);
      padding: var(--space-1);
    }
    .settings-segment button {
      min-height: var(--control-h-sm);
      border-color: transparent;
      background: transparent;
      color: var(--muted);
    }
    .settings-segment button.on,
    .settings-segment button[aria-pressed="true"] {
      background: var(--color-surface-active);
      color: var(--text);
    }
    .settings-toggle {
      position: relative;
      width: 42px;
      height: 24px;
      min-height: 24px;
      border: var(--border-width-1) solid var(--color-border);
      border-radius: var(--radius-full);
      background: var(--color-surface);
      padding: 2px;
    }
    .settings-toggle::after {
      content: "";
      position: absolute;
      top: 3px;
      left: 3px;
      width: 16px;
      height: 16px;
      border-radius: var(--radius-full);
      background: var(--muted);
      transition: transform var(--dur-1) var(--ease-out), background var(--dur-1) var(--ease-out);
    }
    .settings-toggle.on,
    .settings-toggle[aria-checked="true"] {
      border-color: var(--accent-line);
      background: var(--accent-soft);
    }
    .settings-toggle.on::after,
    .settings-toggle[aria-checked="true"]::after {
      transform: translateX(18px);
      background: var(--accent);
    }
    @media (max-width: 920px) {
      .settings-grid,
      .settings-row,
      .settings-control-pair {
        grid-template-columns: 1fr;
      }
      .settings-side {
        position: static;
      }
      .settings-swatches,
      .settings-segment {
        justify-content: flex-start;
      }
    }`
}
