# GitHub Pages

The `OpenWiki Static Export` workflow publishes the public GitHub Pages
artifact when Pages is enabled for the repository. The Pages root is the MkDocs
documentation site so release-day reachability checks can verify docs pages such
as `/reference/distribution/`, `/guides/mcp-and-agents/`, and `/security/`.

The workflow also exports `examples/basic-wiki` as a read-only OpenWiki demo
under `/demo/`. Static export remains the recommended public demo tier because
it has no hosted write surface and still publishes machine-readable artifacts
for agents.

Expected public routes after a successful Pages deploy:

| Route | Purpose |
| --- | --- |
| `/` | Public OpenWiki documentation. |
| `/reference/distribution/` | Distribution and release artifact contract. |
| `/guides/mcp-and-agents/` | Local and hosted agent setup. |
| `/security/` | Security posture and reporting pointer. |
| `/demo/` | Static export demo from `examples/basic-wiki`. |
