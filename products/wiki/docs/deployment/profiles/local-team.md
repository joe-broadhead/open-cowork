# Local Team

Use this for a trusted single-node team wiki run from source or the generated
CLI tarball.

```sh
openwiki setup team ./team-wiki \
  --title "Team Wiki" \
  --team-group group:team
openwiki --root ./team-wiki doctor --profile hosted --json
openwiki --root ./team-wiki serve --host 127.0.0.1 --port 3030
```

Keep the process on loopback unless an authenticated reverse proxy or private
gateway owns TLS, identity, header stripping, and network access. Set
`OPENWIKI_PUBLIC_ORIGIN` to the browser-visible HTTPS origin. Use scoped
service-account tokens and proposal-mode tools for agents.

This repository does not ship a qualified server deployment. The operator owns
process supervision, storage, monitoring, backup, restore rehearsal, upgrade,
and rollback for a source-hosted instance.

Use the [Operations](../operations.md),
[authentication boundary](../auth-boundaries.md), and
[hosted humans and agents](../hosted-human-agent.md) guides before sharing the
runtime.
