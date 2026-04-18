# Versioning and Release Cadence

This page is the source of truth for how Open Cowork versions itself,
how often releases are cut, and what downstream forks can expect in
terms of stability. It complements
[`release-checklist.md`](release-checklist.md), which covers the
mechanical checklist for cutting a tag.

## Semantic versioning

Open Cowork follows [Semantic Versioning 2.0](https://semver.org/):

- **Major** (`X.0.0`) — breaking changes to the public surface. See
  ["What counts as breaking"](#what-counts-as-breaking) below.
- **Minor** (`0.X.0`) — additive features, non-breaking config fields,
  new built-in capabilities, new locales.
- **Patch** (`0.0.X`) — bug fixes, security patches, documentation
  corrections, dependency bumps that don't change the public surface.

Pre-1.0 Open Cowork may batch breaking changes into minor releases so
early-adopter forks aren't bumped to `1.0` prematurely. This is flagged
explicitly in `CHANGELOG.md` under a `Breaking Changes` subsection
whenever it applies. From `1.0` forward the semver contract is strict.

## Release cadence

Open Cowork ships on a **rolling cadence** rather than a fixed calendar:

- **Patch releases** are tagged when there's a meaningful bug fix
  ready. No minimum frequency — if the main branch has been green for
  a week with no user-visible fixes, there won't be a new patch.
- **Minor releases** are tagged when a feature set is complete and
  stable on main for at least 48 hours of dogfood. Typically every
  2–6 weeks in active development.
- **Security patches** are tagged ASAP — expect a same-week release
  for any non-speculative issue affecting the main-process attack
  surface (IPC, preload, safeStorage, CSP, MCP policy).

There is no fixed LTS track. The `main` branch is the canonical line;
forks that need a frozen base should pin to a tagged version and
backport patches themselves. See
[Support policy](#support-policy) for what upstream will help with.

## Pre-release and release candidates

For minor releases that touch a large surface — a renderer refactor, an
OpenCode SDK bump, a CSP rework — we cut a release candidate first:

- `vX.Y.0-rc.1`, `-rc.2`, … published as a full GitHub Release with
  the same artifact set (DMG, zip, AppImage, deb, SHA256SUMS, SBOM,
  provenance). RCs are marked "Pre-release" in the GitHub Release UI
  so the auto-update channel (when downstream enables it) can skip
  them.
- An RC is promoted to a final release tag once it has been on main
  for at least 72 hours without regressions flagged in issues.
- If a blocker lands, we bump `-rc.N` and restart the 72-hour clock.

Patch releases typically skip the RC step. If a patch accumulates
enough surface change to warrant a pre-release (e.g., a full dependency
bump), we'll document that in the changelog and cut `-rc` tags for
it too.

## What counts as breaking

The following are treated as breaking and bump the major version:

- **Config schema** — removing or renaming a field in
  `open-cowork.config.json` that downstream configs already use.
  Adding a new optional field is non-breaking.
- **Preload API** — removing a method from `window.coworkApi`, or
  changing the shape of an existing method's parameters or return
  type.
- **IPC channels** — removing a handler, or changing the shape of
  the request / response payload for an existing channel.
- **Branded data-directory layout** — changing where `sessions.json`
  or the credential vault lives on disk in a way that would lose
  a user's existing state (unless a migration is provided).
- **Built-in catalog keys** — removing an i18n catalog key that
  downstream strings override.
- **OpenCode SDK version** — bumping the required SDK major version.

The following are **not** breaking and land in minor / patch:

- Adding a new locale.
- Adding a new built-in agent, MCP, or skill.
- Tightening a security policy (SSRF guard, CSP) as long as the
  escape hatch — `allowPrivateNetwork`, etc. — stays available.
- Renaming an internal function that isn't part of the preload or
  config surface.

## Support policy

- **Current minor (`vX.Y.*`)** — security fixes, regression fixes,
  and critical correctness bugs land as patch releases.
- **Previous minor** — security fixes only, and only when the fix
  is mechanically backportable (cherry-pick without conflicts).
  Non-security bugs are fixed on main and rolled into the next minor.
- **Older minors** — no upstream patches. Forks that need support
  beyond the previous minor should pin, backport, and optionally
  carry a downstream release tag (see
  [`downstream.md`](downstream.md) for the rebranding workflow).

If you're a downstream fork and need a longer support window, we're
happy to coordinate — open a GitHub Discussion describing the timeline
and we'll document the arrangement as an addendum to this page.

## Changelog hygiene

Every user-visible change lands in `CHANGELOG.md` under the
`[Unreleased]` heading at merge time, categorized as **Added /
Changed / Fixed / Removed / Breaking Changes / Security**. At release
time the `[Unreleased]` heading is renamed to `[vX.Y.Z] - YYYY-MM-DD`,
a fresh `[Unreleased]` is added above it, and the rename is included
in the release PR.

The release-notes body on the GitHub Release page mirrors the
`[vX.Y.Z]` block so consumers reading the Release UI get the same
summary as those reading the repo directly.
