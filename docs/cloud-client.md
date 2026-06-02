---
title: Cloud Client Package
description: Workspace package contract for the typed Open Cowork Cloud HTTP and SSE client.
---

# Cloud Client Package

`@open-cowork/cloud-client` is the typed Cloud HTTP/SSE client used by Open
Cowork first-party clients. It is a supported workspace/source package for the
current repo, not an independently versioned public npm SDK yet. Desktop cloud
workspaces, Cloud Web, Gateway, and downstream builds from this repo should use
this package instead of importing Cloud control-plane internals.

## Contract

- The client talks to Open Cowork Cloud product APIs over HTTP and SSE.
- It does not import Electron, Desktop main-process modules, control-plane
  stores, Postgres modules, or `@opencode-ai/sdk`.
- It may depend on `@open-cowork/shared`, which is the shared workspace/source
  package for Open Cowork product and wire types.
- OpenCode still owns execution. The client only creates sessions, sends
  product commands, reads projections, subscribes to events, and manages
  product surfaces such as workflows, artifacts, BYOK metadata, and channel
  deliveries.
- While Open Cowork is pre-1.0 and the package ships with the repo, typed API
  changes can happen in ordinary repo releases. Treat it as a source-level
  contract until an explicit standalone SDK publishing policy is announced.
  Breaking changes after `1.0.0` require a major version.
- Modules outside the documented entry points are internal. Do not import
  Desktop Cloud server files, control-plane stores, runtime adapters, or source
  files from first-party clients or downstream deployments.

## Entry Points

```ts
import { createHttpSseCloudTransportAdapter } from '@open-cowork/cloud-client'
import type { CloudTransportAdapter } from '@open-cowork/cloud-client/adapter'
import type { SessionListPage } from '@open-cowork/cloud-client/domains/sessions'
```

The package exports only compiled `dist` entry points:

- `@open-cowork/cloud-client`
- `@open-cowork/cloud-client/adapter`
- `@open-cowork/cloud-client/domains/artifacts`
- `@open-cowork/cloud-client/domains/billing`
- `@open-cowork/cloud-client/domains/byok`
- `@open-cowork/cloud-client/domains/capabilities`
- `@open-cowork/cloud-client/domains/channels`
- `@open-cowork/cloud-client/domains/config`
- `@open-cowork/cloud-client/domains/identity`
- `@open-cowork/cloud-client/domains/sessions`
- `@open-cowork/cloud-client/domains/settings`
- `@open-cowork/cloud-client/domains/threads`
- `@open-cowork/cloud-client/domains/transport`
- `@open-cowork/cloud-client/domains/workflows`

## Desktop Bearer Client

```ts
import { createHttpSseCloudTransportAdapter } from '@open-cowork/cloud-client'

const client = createHttpSseCloudTransportAdapter({
  baseUrl: 'https://cowork.example.com',
  headers: { authorization: `Bearer ${oidcAccessToken}` },
  requestTimeoutMs: 30_000,
})

const session = await client.createSession({ profileName: 'default' })
await client.promptSession(session.session.sessionId, { text: 'Run the release checks' })
```

Desktop should create this client in the main process. The renderer should
receive workspace views and status, not refresh tokens, provider keys, or raw
cloud credentials.

## Gateway Service-Token Client

```ts
import { createHttpSseCloudTransportAdapter } from '@open-cowork/cloud-client'

const gatewayClient = createHttpSseCloudTransportAdapter({
  baseUrl: 'https://cowork.example.com',
  headers: { authorization: `Bearer ${gatewayServiceToken}` },
  requestTimeoutMs: 30_000,
})

gatewayClient.subscribeChannelDeliveries?.({
  claimedBy: 'gateway-shard-a',
  onDelivery(delivery) {
    deliverToChannel(delivery)
  },
})
```

The service token authenticates the gateway process. The channel actor still
needs to be resolved through Cloud identity/RBAC APIs before the gateway can
prompt, approve, answer questions, or mutate channel state.

## Browser Client

```ts
const client = createHttpSseCloudTransportAdapter({
  baseUrl: window.location.origin,
  credentials: 'include',
  csrfToken: bootstrap.csrfToken,
})
```

Browser clients use cookie auth and CSRF for mutating requests. Operator-only
APIs should remain behind operator auth or private networking and must not be
called from ordinary browser workbench code.

## Auth Modes

| Mode | Caller | Transport |
| --- | --- | --- |
| Cookie | Cloud Web browser | `credentials: 'include'` plus CSRF token |
| Bearer | Desktop main process | `Authorization: Bearer <OIDC access token>` |
| Service token | Gateway daemon or automation | `Authorization: Bearer <scoped API token>` |
| Operator | Deployment/operator tooling only | Operator token or private network gate |

## Timeouts And Cancellation

`requestTimeoutMs` defaults to 30 seconds and is clamped to
`100ms..120000ms`. `0` disables HTTP timeouts and should only be used in tests
or explicitly controlled deployments. Use `signal` to cancel in-flight HTTP
requests and SSE subscriptions:

```ts
const controller = new AbortController()
const client = createHttpSseCloudTransportAdapter({
  baseUrl: 'https://cowork.example.com',
  headers: { authorization: `Bearer ${token}` },
  signal: controller.signal,
})

controller.abort()
```

SSE subscriptions are long-lived streams and are not governed by
`requestTimeoutMs`.

The client does not retry automatically. Callers should choose retries per
operation because mutating Cloud commands are durable and may be idempotency
aware on the server.

## SSE Authentication

Bearer-token clients use fetch-based SSE so the `Authorization` header is sent
with stream requests. Cookie-authenticated browser clients use `EventSource`
when no custom headers are configured.

SSE subscription URLs accept an `afterSequence` cursor. Clients should persist
the highest processed sequence, resume with `afterSequence` after reconnect or
process restart, and close subscriptions when the workspace/session/channel
binding is no longer active.

```ts
import {
  createHttpSseCloudTransportAdapter,
  isCloudTransportError,
} from '@open-cowork/cloud-client'

const subscription = client.subscribeSessionEvents('session-id', {
  afterSequence: lastSeenSequence,
  onEvent(event) {
    lastSeenSequence = Math.max(lastSeenSequence, event.sequence)
  },
  onError(error) {
    if (isCloudTransportError(error) && error.kind === 'unauthorized') {
      requestReauth()
    }
  },
})

subscription.close()
```

Reconnect and backoff policy belong to the caller because Desktop, Web, and
Gateway have different UI and delivery semantics.

## Error Taxonomy

The client exports `CloudTransportError`, `CloudTransportErrorKind`, and
`isCloudTransportError`. Clients should branch on typed fields instead of
parsing strings.

| Kind | Meaning |
| --- | --- |
| `unauthorized` | HTTP 401, expired or missing auth |
| `forbidden` | HTTP 403, membership or policy denial |
| `payment_required` | HTTP 402, subscription or entitlement gate |
| `not_found` | HTTP 404 |
| `conflict` | HTTP 409, stale projection or command conflict |
| `rate_limited` | HTTP 429, `retryAfter` may be set |
| `server` | HTTP 5xx |
| `http` | Other non-2xx HTTP status |
| `timeout` | Client request timeout |
| `abort` | Caller cancellation |
| `parse` | Invalid JSON response or SSE payload |
| `sse` | EventSource/fetch-SSE startup or stream failure |
| `network` | Fetch/network failure before an HTTP response |
| `request` | Invalid client request construction |

## Release Checklist

- Build shared first: `pnpm --filter @open-cowork/shared build`.
- Build the client package: `pnpm --filter @open-cowork/cloud-client build`.
- Run transport and package-boundary tests.
- Confirm package exports only the documented entry points.
- Update README and this page when auth, timeout, SSE, or error behavior
  changes.
- Keep examples free of private deployment URLs, org ids, tokens, provider keys,
  and project-specific values.
- Pre-1.0 typed breaks must be called out in release notes. Do not add
  `publishConfig`, mark the package publishable, or present it as a standalone
  published SDK until package publication, versioning, provenance, and support
  ownership are explicit.
