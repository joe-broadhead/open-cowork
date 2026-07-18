# local-team

Use this for a private team wiki on a trusted LAN or VPN before moving to a
hosted SSO deployment. The runtime is the same as `docker-private`, but the
operating assumption is a small group with a single writable host.

## Quickstart

Start from the [Docker And Compose profile](docker-compose.md), set
`OPENWIKI_PUBLIC_ORIGIN` to the internal HTTPS origin if browser writes are
used, and put the service behind a trusted reverse proxy when it is reachable by
more than one person.

```sh
openwiki setup team ./team-wiki \
  --title "Team Wiki" \
  --team-group group:team
openwiki --root ./team-wiki deploy preflight \
  --deploy-profile docker-private \
  --public-origin https://wiki.internal.example
```

## Preflight

```sh
openwiki --root ./team-wiki deploy preflight --deploy-profile docker-private --public-origin https://wiki.internal.example
```

## Security Notes

- Treat `group:all-users` as authenticated users inside the trusted boundary.
- Do not expose write-capable HTTP or MCP routes directly to the public internet.
- Use service-account tokens for agents and proposal mode until a maintainer
  explicitly needs write mode.

## Operations

Use the [Operations](../operations.md) index for monitoring, backup, write
coordination, and incident response. Move to Kubernetes or another hosted
profile when you need multiple web replicas, externalized state, or independent
workers.
