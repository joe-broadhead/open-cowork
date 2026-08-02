# Runtime Profiles

`runtime.profile` selects safety defaults; it is not a packaging or hosting
claim.

| Profile | Runtime mode | Intended use |
| --- | --- | --- |
| `local` | `local` | Personal source checkout or CLI-tarball workspace |
| `team` | `team` | Trusted single-node team workspace |
| `hosted` | `hosted` | Source-operated authenticated service with shared stores |
| `static` | `local` | Read-only static export source |
| `enterprise` | `enterprise` | Source-operated runtime with fail-closed shared-store requirements |

`OPENWIKI_RUNTIME_MODE=local|team|hosted|enterprise` may override the stored
profile. Hosted and enterprise modes require Postgres-backed read, search,
queue, and operational state before readiness passes. Local and team modes keep
SQLite and single-process fallbacks.

## Active User Paths

- [Local Personal](profiles/local-personal.md)
- [Local Team](profiles/local-team.md)
- [Public Static](profiles/public-static.md)
- [Hosted Humans And Agents](hosted-human-agent.md)

For a source-operated network service, also configure:

- an authenticated ingress boundary;
- an HTTPS `OPENWIKI_PUBLIC_ORIGIN`;
- scoped service-account tokens for HTTP MCP;
- Postgres write coordination and operational state before multiple writers or
  replicas;
- Git, workspace, Postgres, object-storage, and secret backups as applicable.

Validate the runtime, not a platform manifest:

```sh
openwiki --root <wiki> doctor --profile personal --json
openwiki --root <wiki> doctor --profile hosted --json
```
