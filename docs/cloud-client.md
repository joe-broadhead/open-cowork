---
title: Cloud Client SDK
description: Public package contract for the typed Open Cowork Cloud HTTP and SSE client.
---

# Cloud Client SDK

`@open-cowork/cloud-client` is the supported typed client for Open Cowork Cloud.
Desktop cloud workspaces, Cloud Web, Gateway, and downstream clients should use
this package instead of importing Cloud control-plane internals.

## Contract

- The client talks to Open Cowork Cloud product APIs over HTTP and SSE.
- It does not import Electron, Desktop main-process modules, control-plane
  stores, Postgres modules, or `@opencode-ai/sdk`.
- It may depend on `@open-cowork/shared`, which is the public package for
  shared Open Cowork product and wire types.
- OpenCode still owns execution. The client only creates sessions, sends
  product commands, reads projections, subscribes to events, and manages
  product surfaces such as workflows, artifacts, BYOK metadata, and channel
  deliveries.
- While Open Cowork is pre-1.0, typed API changes can happen in minor releases.
  Breaking changes after `1.0.0` require a major version.

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

## Node Or Daemon Client

```ts
import { createHttpSseCloudTransportAdapter } from '@open-cowork/cloud-client'

const client = createHttpSseCloudTransportAdapter({
  baseUrl: 'https://cowork.example.com',
  headers: { authorization: `Bearer ${token}` },
  requestTimeoutMs: 30_000,
})

const session = await client.createSession({ profileName: 'default' })
await client.promptSession(session.session.sessionId, { text: 'Run the release checks' })
```

## Browser Client

```ts
const client = createHttpSseCloudTransportAdapter({
  baseUrl: window.location.origin,
  credentials: 'include',
  csrfToken: bootstrap.csrfToken,
})
```

## Timeouts And Cancellation

`requestTimeoutMs` defaults to 30 seconds. Use `signal` to cancel in-flight HTTP
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

The client does not retry automatically. Callers should choose retries per
operation because mutating Cloud commands are durable and may be idempotency
aware on the server.

## SSE Authentication

Bearer-token clients use fetch-based SSE so the `Authorization` header is sent
with stream requests. Cookie-authenticated browser clients use `EventSource`
when no custom headers are configured.
