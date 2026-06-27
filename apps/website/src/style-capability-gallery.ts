// Capability gallery styling — extracted from style-components.ts to keep that
// module under its line budget. Mirrors the desktop CapabilityMapView: a
// responsive multi-column grid of identity-tinted tiles, each with an
// entity-tile icon plate (--entity-chroma), a hover spine (--spine), an
// instrument-readout meta line, and a depends-on rail. Consumed (interpolated)
// by cloudWebsiteComponentStyles().
export function cloudWebsiteCapabilityGalleryStyles() {
  return String.raw`    /* Capability gallery — a responsive multi-column grid of identity-tinted
       tiles, mirroring the desktop CapabilityMapView (md:2 / xl:3 columns). The
       grid overrides the single-column .list container it portals into. */
    .capability-gallery {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
      gap: var(--gap);
      align-items: start;
      min-width: 0;
    }
    .capability-tile {
      overflow: hidden;
      align-items: stretch;
    }
    /* Hover spine keyed to the same --spine hue as the icon plate. */
    .capability-tile::after {
      content: "";
      position: absolute;
      inset-block: 0;
      inset-inline-start: 0;
      width: 2px;
      background: color-mix(in srgb, var(--spine, var(--color-accent)) 60%, transparent);
      opacity: 0;
      transition: opacity var(--dur-1) var(--ease-out);
      pointer-events: none;
    }
    .capability-tile:hover::after {
      opacity: 1;
    }
    .capability-tile-head {
      display: flex;
      align-items: flex-start;
      gap: var(--space-3);
      min-width: 0;
    }
    .capability-tile-icon {
      width: 36px;
      height: 36px;
      border-radius: var(--radius-md);
      color: var(--color-text);
    }
    .capability-tile-headings {
      display: grid;
      gap: var(--space-1);
      min-width: 0;
      flex: 1;
    }
    /* Instrument-readout meta line — tabular metadata with dot separators. */
    .capability-tile-readout {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-2);
      color: var(--color-text-muted);
      font-size: var(--text-xs);
      line-height: var(--lh-xs);
      font-variant-numeric: tabular-nums;
    }
    .capability-tile-readout-item {
      display: inline-flex;
      align-items: center;
      gap: var(--space-2);
    }
    .capability-tile-readout-sep {
      color: color-mix(in srgb, var(--color-text-muted) 60%, transparent);
    }
    .capability-tile-rail {
      display: grid;
      gap: var(--space-1);
      padding-top: var(--space-2);
      border-top: var(--border-width-1) solid var(--color-border-subtle);
      min-width: 0;
    }
    @media (max-width: 920px) {
      .capability-gallery {
        grid-template-columns: 1fr;
      }
    }`
}
