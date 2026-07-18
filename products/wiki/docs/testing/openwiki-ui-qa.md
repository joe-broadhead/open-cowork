# OpenWiki UI QA Checklist

Use this checklist before merging UI changes that affect static export, the live
server, command palette, graph rendering, or proposal forms.

## Required Commands

```sh
pnpm build:web
pnpm validate
pnpm check:bundle
pnpm test:ui
pnpm test:ui-quality
pnpm screenshots
git diff --check
```

Run `actionlint` when the binary is available locally or in CI. If Playwright has
not installed a browser locally, run `pnpm exec playwright install chromium`
before `pnpm test:ui-quality` or `pnpm screenshots`.

## Static Export

- `index.html` loads hashed `assets/openwiki.*.css` and `assets/openwiki.*.js`.
- Page links target `.html` by default while `.md` and `.json` siblings remain.
- Asset links are relative, not root-relative, so GitHub Pages subpaths work.
- `graph.html`, `topics.html`, and `changes.html` render with useful no-JS content.
- `llms.txt`, `llms-full.txt`, `openapi.json`, `mcp-manifest.json`, JSONL exports,
  and `sitemap.xml` are still present.

## Live Server

- `GET /` and `HEAD /` return `200` and `text/html`.
- `/_assets/openwiki.css` and `/_assets/openwiki.js` return the expected content
  type.
- `/graph` includes the interactive graph mount and SVG fallback.
- `/graph` loads the bounded seed graph by default, and focused graph pages load
  the selected record neighborhood rather than the full graph JSON.
- `/api/v1/records` supports type/prefix/cursor listing for lazy navigation.
- `/pages/{id}` includes rendered markdown, local graph, sources, claims, history,
  governance, and machine-readable links.
- Proposal create/review/close/apply forms keep their existing `method`, `action`,
  and `name` attributes.
- Page edit forms show a live markdown preview while preserving the submitted
  `body` field.
- Spaces preview, create-space, and advanced policy forms keep their existing
  `method`, `action`, and `name` attributes.

## Interaction

- Theme toggle switches dark/light and persists after reload.
- Command palette opens with the search button, `/`, and `Cmd/Ctrl+K`.
- Static palette searches `search-index.json` and links to `.html` records.
- Live palette searches `/api/v1/search` and links to server record routes.
- Palette empty state, type facets, focus trap, theme command, and Enter
  navigation are covered by browser QA.
- Graph canvas is nonblank; wheel zoom, background pan, node hover, node drag, and
  click-through navigation work.
- `artifacts/openwiki-ui-quality.json` records static page performance, CLS,
  no-third-party-request, landmark, form-label, theme contrast, overflow, component
  preview, and graph nonblank checks.
- `artifacts/openwiki-screenshots/manifest.json` lists screenshots for static
  home/page/graph, web component preview, and server dashboard/page/graph/proposal/
  policy/edit across mobile, tablet, desktop, and wide desktop.

Latest local UI evidence for this pass:

- `artifacts/openwiki-ui-quality.json`
- `artifacts/openwiki-screenshots/manifest.json`

## Accessibility

- Topbar, primary navigation, main landmark, footer, and skip link are present.
- Icon-only controls have accessible names.
- Focus-visible states are visible for keyboard users.
- Color is not the only signal for badges or graph state.
- Graph has a text fallback for no-JS and assistive review.
- The component preview renders both `data-preview-theme="dark"` and
  `data-preview-theme="light"` with no automated contrast failures.

## Responsive Review

Check at these viewport widths:

- 360px mobile
- 768px tablet
- 1280px desktop
- 1920px wide desktop

At each width, verify the topbar, command palette, article pages, graph page, and
proposal forms do not overlap or clip important text.
