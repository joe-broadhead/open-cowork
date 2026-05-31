# @open-cowork/cloud-client

Typed HTTP and SSE client for Open Cowork Cloud.

## Support Status

`@open-cowork/cloud-client` is a supported public package surface for Open
Cowork clients and downstream deployers. The package is still versioned with
the repository while Open Cowork is pre-1.0, so typed API changes may occur in
minor releases until `1.0.0`. Runtime execution remains owned by OpenCode; this
client only talks to Open Cowork Cloud product APIs.

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
- `@open-cowork/cloud-client/domains/sessions`
- `@open-cowork/cloud-client/domains/settings`
- `@open-cowork/cloud-client/domains/threads`
- `@open-cowork/cloud-client/domains/transport`
- `@open-cowork/cloud-client/domains/workflows`

The package must not import Electron, Desktop main-process modules,
control-plane stores, or `@opencode-ai/sdk`. Its only Open Cowork package
dependency is the public `@open-cowork/shared` wire-type package.

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

## Browser Cookie Usage

```ts
import { createHttpSseCloudTransportAdapter } from '@open-cowork/cloud-client'

const client = createHttpSseCloudTransportAdapter({
  baseUrl: window.location.origin,
  credentials: 'include',
  csrfToken: bootstrap.csrfToken,
})
```

## Timeouts, Cancellation, And Retries

- `requestTimeoutMs` defaults to 30 seconds and is clamped to a safe maximum.
- `signal` cancels all HTTP requests and SSE subscriptions created from the
  client.
- The client does not retry automatically. Callers should decide retries per
  command because some mutating operations are intentionally durable and
  idempotency-aware on the server.

## SSE Authentication

When `headers` are configured, SSE subscriptions use fetch-based SSE so bearer
tokens are sent with the stream request. Without headers, the browser
`EventSource` path is used for cookie-authenticated deployments.
