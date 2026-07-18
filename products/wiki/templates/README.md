# OpenWiki Template Reference

Starter templates define common first-workspace shapes for `openwiki init`.
The runtime template definitions are implemented in `@openwiki/repo` so the CLI,
tests, Docker image, and source checkout all use the same seed logic. The
directories here are reference documentation for those code-backed templates,
not filesystem template sources.

Available templates:

- `basic`: minimal local OpenWiki starter.
- `team-wiki`: private team knowledge base with Spaces and proposal review.
- `personal-wiki`: personal knowledge base with project context.
- `company-wiki`: compatibility alias for the private team wiki starter.
- `public-encyclopedia`: public, citation-first wiki starter.
- `github-pages`: static-first public wiki starter.

Use a template with:

```sh
openwiki init my-wiki --template personal-wiki
```

The generated workspace includes `openwiki.json`, `wiki/`, `sources/`,
`claims/`, `policy/`, `proposals/`, `events/`, and `runs/` as appropriate for
the selected template.
