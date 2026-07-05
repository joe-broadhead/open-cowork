# @open-cowork/cloud-client

Typed HTTP and SSE client for Open Cowork Cloud.

## Support Status

`@open-cowork/cloud-client` is the supported typed Cloud HTTP/SSE client for
Open Cowork clients built from this repo. It is still a workspace/source
package, not an independently versioned public npm SDK. While Open Cowork is
pre-1.0, typed API changes may occur in ordinary repo releases until a
standalone SDK publishing and support policy is announced. Runtime execution
remains owned by OpenCode; this client only talks to Open Cowork Cloud product
APIs.

## Entry Points

- `@open-cowork/cloud-client`
- `@open-cowork/cloud-client/adapter`
- `@open-cowork/cloud-client/domains/artifacts`
- `@open-cowork/cloud-client/domains/billing`
- `@open-cowork/cloud-client/domains/byok`
- `@open-cowork/cloud-client/domains/capabilities`
- `@open-cowork/cloud-client/domains/channels`
- `@open-cowork/cloud-client/domains/config`
- `@open-cowork/cloud-client/domains/identity`
- `@open-cowork/cloud-client/domains/launchpad`
- `@open-cowork/cloud-client/domains/sessions`
- `@open-cowork/cloud-client/domains/settings`
- `@open-cowork/cloud-client/domains/threads`
- `@open-cowork/cloud-client/domains/transport`
- `@open-cowork/cloud-client/domains/workflows`

The package must not import Electron, Desktop main-process modules,
control-plane stores, or `@opencode-ai/sdk`. Its only Open Cowork package
dependency is the shared workspace/source `@open-cowork/shared` wire-type
package.

Modules outside the entry points above are internal implementation details.
First-party clients and downstream deployers should not import source files,
Desktop Cloud server files, control-plane stores, or runtime adapters directly.

## Basic Usage

```ts
import { createHttpSseCloudTransportAdapter } from '@open-cowork/cloud-client'

const client = createHttpSseCloudTransportAdapter({
  baseUrl: 'https://cowork.example.com',
  headers: { authorization: `Bearer ${token}` },
  requestTimeoutMs: 30_000,
})

const session = await client.createSession({ profileName: 'default' })
await client.promptSession(session.session.sessionId, { text: 'Run the checks' })
```

## Desktop Bearer Usage

Desktop clients authenticate with an OIDC access token or scoped API token owned
by the Desktop main process. The renderer must not receive refresh tokens or raw
cloud secrets.

```ts
import { createHttpSseCloudTransportAdapter } from '@open-cowork/cloud-client'

const desktopClient = createHttpSseCloudTransportAdapter({
  baseUrl: 'https://cowork.example.com',
  headers: { authorization: `Bearer ${accessToken}` },
  requestTimeoutMs: 30_000,
  signal: desktopAbortController.signal,
})
```

## Gateway Service-Token Usage

Gateway daemons authenticate with a scoped service token. The gateway token only
authenticates the daemon; inbound channel users still need to be resolved
through Cloud identity/RBAC APIs before prompts, approvals, or deliveries are
accepted.

```ts
import { createHttpSseCloudTransportAdapter } from '@open-cowork/cloud-client'

const gatewayClient = createHttpSseCloudTransportAdapter({
  baseUrl: 'https://cowork.example.com',
  headers: { authorization: `Bearer ${gatewayServiceToken}` },
  requestTimeoutMs: 30_000,
})

gatewayClient.subscribeChannelDeliveries?.({
  claimedBy: 'gateway-us-central1-a',
  onDelivery(delivery) {
    queueDeliveryForProvider(delivery)
  },
})
```

## Browser Cookie Usage

```ts
import { createHttpSseCloudTransportAdapter } from '@open-cowork/cloud-client'

const client = createHttpSseCloudTransportAdapter({
  baseUrl: window.location.origin,
  credentials: 'include',
  csrfToken: bootstrap.csrfToken,
})
```

Browser clients use cookie auth plus CSRF protection for mutating requests.
Operator-only APIs still require server-side authorization; do not expose admin
or operator tokens to browser JavaScript.

## Auth Modes

| Mode | Caller | Transport |
| --- | --- | --- |
| Cookie | Cloud Web in browser | `credentials: 'include'` plus CSRF token |
| Bearer | Desktop main process | `Authorization: Bearer <OIDC access token>` |
| Service token | Gateway daemon and automation | `Authorization: Bearer <scoped API token>` |
| Operator | Deployment/operator tooling only | Operator token or private network gate |

Operator APIs are not general product APIs. Downstream deployments should expose
them only behind private networking, operator authentication, or equivalent
administrative controls.

## Timeouts, Cancellation, And Retries

- `requestTimeoutMs` defaults to 30 seconds.
- Values are clamped to `100ms..120000ms`; `0` disables HTTP timeouts and should
  be reserved for tests or explicitly controlled deployments.
- `signal` cancels all HTTP requests and SSE subscriptions created from the
  client. Pass a new client-scoped `AbortController` when a workspace, account,
  or daemon lifecycle ends.
- SSE subscriptions are long-lived streams and are not governed by
  `requestTimeoutMs`.
- The client does not retry automatically. Callers should decide retries per
  command because some mutating operations are intentionally durable and
  idempotency-aware on the server.

All non-SSE HTTP requests are bounded by the timeout unless timeout is explicitly
disabled. Fetch, parse, timeout, abort, and HTTP failures are surfaced as
`CloudTransportError` instances.

## SSE Authentication

When `headers` are configured, SSE subscriptions use fetch-based SSE so bearer
tokens are sent with the stream request. Without headers, the browser
`EventSource` path is used for cookie-authenticated deployments.

SSE URLs accept `afterSequence` cursors. Clients should persist the highest
processed sequence and resume with `afterSequence` after reconnect or process
restart. The returned subscription has a `close()` method; callers must close it
when the workspace/session/gateway binding is no longer active. Reconnect policy
belongs to the caller because Desktop, Web, and Gateway have different UI and
delivery semantics.

```ts
import { isCloudTransportError } from '@open-cowork/cloud-client'

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

## Error Taxonomy

The client exports `CloudTransportError`, `CloudTransportErrorKind`, and
`isCloudTransportError`. Callers should branch on `kind`, `status`, and `code`
rather than parsing human-readable messages.

| Kind | Typical source |
| --- | --- |
| `unauthorized` | HTTP 401, expired or missing auth |
| `forbidden` | HTTP 403, membership or policy denial |
| `payment_required` | HTTP 402, inactive subscription or entitlement gate |
| `not_found` | HTTP 404 |
| `conflict` | HTTP 409, stale projection or command conflict |
| `rate_limited` | HTTP 429, optional `retryAfter` available |
| `server` | HTTP 5xx |
| `http` | Other non-2xx HTTP status |
| `timeout` | Client request timeout |
| `abort` | Caller cancellation |
| `parse` | Invalid JSON response or SSE payload |
| `sse` | EventSource/fetch-SSE startup or stream failure |
| `network` | Fetch/network failure before an HTTP response |
| `request` | Invalid client request construction |

## Release Checklist

Before publishing or treating a repo release as a cloud-client contract update:

- Run `pnpm --filter @open-cowork/shared build`.
- Run `pnpm --filter @open-cowork/cloud-client build`.
- Run the cloud transport and boundary tests.
- Confirm `packages/cloud-client/package.json` exports only documented entry
  points.
- Confirm README and `docs/cloud-client.md` document new auth, timeout, SSE, and
  error behavior.
- Do not include private deployment URLs, tokens, org ids, or provider keys in
  examples or fixtures.
- For pre-1.0 releases, document typed API breaks in release notes. After
  `1.0.0`, follow SemVer major-version rules for breaking changes.
- Do not present this as a standalone published SDK until package publication,
  versioning, and support ownership are explicit.
