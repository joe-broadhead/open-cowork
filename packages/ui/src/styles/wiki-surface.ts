// Domain: wiki-surface
// Ownership: packages/ui Studio surface CSS (Wiki surface styles.)
// Consumed via packages/ui/src/surface-styles.ts → studioSurfaceStyles().
// Rules may use only design tokens from @open-cowork/shared (emitRootTokensCss).

export function wikiSurfaceCss(): string {
  return `
    .studio-wiki-rail {
      display: flex;
      min-width: 0;
      flex-direction: column;
      gap: var(--space-3);
      border-inline-end: var(--border-width-1) solid var(--color-border-subtle);
      background: var(--color-surface);
      padding: var(--space-3);
    }
    .studio-wiki-rail__view {
      display: flex;
    }
    .studio-wiki-rail__view > * {
      flex: 1 1 auto;
      min-width: 0;
    }
    .studio-wiki-rail__spaces,
    .studio-wiki-space div {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
    }
    .studio-wiki-space h3 {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      margin: 0 0 var(--space-2);
      color: var(--color-text-secondary);
      font-size: var(--text-2xs);
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    .studio-wiki-space h3 span {
      width: var(--space-5);
      height: var(--space-5);
      border-radius: var(--radius-sm);
    }
    .studio-wiki-rail .studio-wiki-space__meta {
      flex-direction: row;
      flex-wrap: wrap;
      gap: var(--space-1);
      margin: 0 0 var(--space-2);
    }
    .studio-wiki-space__meta span {
      display: inline-flex;
      align-items: center;
      border: var(--border-width-1) solid var(--color-border-subtle);
      border-radius: var(--radius-full);
      padding: 0 var(--space-2);
      font-size: var(--text-2xs);
      line-height: var(--space-5);
      color: var(--color-text-muted);
    }
    .studio-wiki-space__meta .studio-wiki-space__role {
      color: var(--color-text-secondary);
      background: var(--color-elevated);
    }
    .studio-wiki-space button {
      justify-content: flex-start;
      min-height: var(--control-h-sm);
      overflow: hidden;
      border: 0;
      background: transparent;
      color: var(--color-text-secondary);
      padding: 0 var(--space-3);
      text-align: start;
      text-overflow: ellipsis;
    }
    .studio-wiki-space button:hover,
    .studio-wiki-space button[data-active="true"] {
      background: var(--color-elevated);
      color: var(--color-text);
    }
    .studio-wiki-space button:focus-visible {
      outline: none;
      box-shadow: var(--ring-focus);
    }
    .studio-wiki-page {
      min-width: 0;
      overflow: auto;
      padding: var(--space-6);
    }
    .studio-wiki-page__crumbs {
      color: var(--color-text-muted);
      font-size: var(--text-xs);
    }
    .studio-wiki-page__head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: var(--space-3);
      margin-top: var(--space-3);
    }
    .studio-wiki-page__head h1 {
      margin: 0;
      color: var(--color-text);
      font-family: var(--font-display);
      font-size: var(--text-2xl);
      line-height: var(--lh-2xl);
    }
    .studio-wiki-page__head-side {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: var(--space-2);
    }
    .studio-wiki-page__body {
      margin-top: var(--space-5);
    }
    .studio-wiki-page__body h2 {
      margin: var(--space-5) 0 var(--space-2);
      color: var(--color-text);
      font-family: var(--font-display);
      font-size: var(--text-lg);
    }
    .studio-wiki-page__body p,
    .studio-wiki-page__body li {
      color: var(--color-text-secondary);
      font-size: var(--text-sm);
      line-height: var(--lh-lg);
    }
    .studio-wiki-page__body ul {
      display: grid;
      gap: var(--space-2);
      margin: var(--space-2) 0;
      padding: 0;
      list-style: none;
    }
    .studio-wiki-page__body li {
      position: relative;
      padding-inline-start: var(--space-5);
    }
    .studio-wiki-page__body li::before {
      content: "";
      position: absolute;
      inset-block-start: 0.75em;
      inset-inline-start: var(--space-2);
      width: var(--space-2);
      height: var(--space-2);
      border-radius: var(--radius-full);
      background: var(--color-accent);
    }
    .studio-wiki-page__callout {
      display: flex;
      gap: var(--space-2);
      border: var(--border-width-1) solid var(--accent-line);
      border-radius: var(--radius-lg);
      background: var(--accent-soft);
      color: var(--color-text);
      padding: var(--space-3) var(--space-4);
    }
    .studio-wiki-page__links {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      margin-top: var(--space-6);
      border-top: var(--border-width-1) solid var(--color-border-subtle);
      padding-top: var(--space-4);
    }
    .studio-wiki-page__links-title {
      flex-basis: 100%;
      margin: 0;
      color: var(--color-text-secondary);
      font-size: var(--text-2xs);
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .studio-wiki-page__links-title small {
      font-weight: 400;
      text-transform: none;
      letter-spacing: 0;
      color: var(--color-text-muted);
    }
    .studio-wiki-page__links span {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      border: var(--border-width-1) solid var(--color-border);
      border-radius: var(--radius-full);
      background: var(--color-surface);
      color: var(--color-text-secondary);
      padding: var(--space-1) var(--space-3);
      font-size: var(--text-xs);
    }
    .studio-wiki-propose {
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
    }
    .studio-wiki-propose__hint {
      margin: 0;
      color: var(--color-text-muted);
      font-size: var(--text-sm);
      line-height: var(--lh-sm);
    }
    .studio-wiki-propose__field {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
    }
    .studio-wiki-propose__field span {
      color: var(--color-text-secondary);
      font-size: var(--text-2xs);
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    .studio-wiki-propose__error {
      margin: 0;
      color: var(--color-red, var(--color-red));
      font-size: var(--text-sm);
    }`
}

// Aggregate of every shared Studio surface stylesheet. Both apps consume this so
// new surfaces are picked up by desktop and Cloud Web from one place.
