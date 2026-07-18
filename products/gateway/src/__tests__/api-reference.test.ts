import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { httpCapabilityForRequest } from '../security.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

describe('generated HTTP API reference', () => {
  const openapi = JSON.parse(fs.readFileSync(path.join(root, 'docs/api/openapi.json'), 'utf-8'))
  const httpApi = fs.readFileSync(path.join(root, 'docs/api/http-api.md'), 'utf-8')

  it('documents scheduler action routes in Markdown and OpenAPI', () => {
    expect(httpApi).toContain('`/scheduler/pause`')
    expect(httpApi).toContain('`/scheduler/resume`')
    expect(httpApi).toContain('`/scheduler/run`')
    expect(openapi.paths['/scheduler/pause']?.post?.responses).toHaveProperty('200')
    expect(openapi.paths['/scheduler/resume']?.post?.responses).toHaveProperty('200')
    expect(openapi.paths['/scheduler/run']?.post?.responses).toHaveProperty('200')
  })

  it('publishes route-specific response statuses instead of generic 200s only', () => {
    expect(openapi.paths['/sessions/admit'].post.responses).toEqual(expect.objectContaining({
      201: expect.any(Object),
      400: expect.any(Object),
      429: expect.any(Object),
    }))
    expect(openapi.paths['/tasks/{id}'].patch.responses).toEqual(expect.objectContaining({
      200: expect.any(Object),
      400: expect.any(Object),
      404: expect.any(Object),
    }))
    expect(openapi.paths['/gateway/leadership/recover'].post.responses).toHaveProperty('409')
    expect(openapi.paths['/storage/doctor'].get.responses).toHaveProperty('503')
    expect(openapi.paths['/readiness'].get.responses).toHaveProperty('503')
    expect(openapi.paths['/personas'].post.responses).toHaveProperty('422')
  })

  it('generates concrete request bodies from the runtime Zod validators', () => {
    const task = openapi.paths['/tasks'].post
    expect(task.requestBody.required).toBe(true)
    expect(task.requestBody.content['application/json'].schema).toMatchObject({
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string', minLength: 1 },
        priority: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'] },
      },
    })

    expect(openapi.paths['/operator/actions'].post.requestBody.content['application/json'].schema).toMatchObject({
      required: ['action'],
      properties: {
        action: { enum: ['status', 'hygiene', 'pause', 'resume', 'recover', 'reset-stale'] },
      },
    })
    expect(openapi.paths['/personas'].post.requestBody.content['application/json'].schema).toMatchObject({
      required: ['name'],
      properties: {
        name: { minLength: 1, maxLength: 64, pattern: '^[a-z0-9]+(-[a-z0-9]+)*$' },
      },
    })
  })

  it('does not publish unconstrained JSON bodies for mutation routes', () => {
    const offenders: string[] = []
    for (const [routePath, methods] of Object.entries(openapi.paths) as Array<[string, Record<string, any>]>) {
      for (const [method, operation] of Object.entries(methods)) {
        const schema = operation.requestBody?.content?.['application/json']?.schema
        if (schema?.type === 'object' && schema.additionalProperties === true && !schema.properties) offenders.push(`${method.toUpperCase()} ${routePath}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('publishes runtime capability auth and bounded message-query contracts', () => {
    for (const [method, routePath, runtimePath] of [
      ['get', '/readiness', '/readiness'],
      ['post', '/alerts/evaluate', '/alerts/evaluate'],
      ['post', '/blueprints/preview', '/blueprints/preview'],
      ['post', '/blueprints/apply', '/blueprints/apply'],
      ['get', '/opencode/sessions/{id}/messages', '/opencode/sessions/session/messages'],
    ] as const) {
      const operation = openapi.paths[routePath][method]
      expect(operation['x-required-capability']).toBe(httpCapabilityForRequest({ method, pathname: runtimePath }))
      expect(operation.security).toEqual([{ gatewayBearer: [] }])
    }

    const messages = openapi.paths['/opencode/sessions/{id}/messages'].get
    expect(messages.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'limit',
        in: 'query',
        schema: { type: 'integer', minimum: 1, maximum: 200 },
      }),
    ]))

    const sessions = openapi.paths['/opencode/sessions'].get
    expect(sessions['x-required-capability']).toBe('read')
    expectConditionalCapability('/config', { redact: false })
    expectConditionalCapability('/events', { raw: true })
    expectConditionalCapability('/events', { unredacted: true })
    expectConditionalCapability('/evidence/export', { redact: false })
    expectConditionalCapability('/evidence/export', { unredacted: true })
    expectConditionalCapability('/runs/{id}', { raw: true })
    expectConditionalCapability('/runs/{id}', { unredacted: true })
    expectConditionalCapability('/opencode/sessions', { all: true })
    expectConditionalCapability('/opencode/sessions', { gatewayOnly: false })
    expectConditionalCapability('/opencode/sessions', { raw: true })
    expectConditionalCapability('/opencode/sessions', { unredacted: true })
    expectConditionalCapability('/opencode/sessions/{id}', { raw: true })
    expectConditionalCapability('/opencode/sessions/{id}', { unredacted: true })
    expectConditionalCapability('/opencode/sessions/{id}', { redact: false })
    expectConditionalCapability('/opencode/mcp', { raw: true })
    expectConditionalCapability('/opencode/mcp', { unredacted: true })
    expectConditionalCapability('/opencode/mcp', { redact: false })
    expect(sessions.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'gatewayOnly',
        schema: { type: 'boolean' },
        description: expect.stringContaining('requires an admin bearer token'),
      }),
    ]))
  })

  it('publishes channel validators and method-specific WhatsApp authentication', () => {
    expect(openapi.paths['/channels/send'].post.requestBody.content['application/json'].schema).toMatchObject({
      required: ['provider', 'chatId', 'text'],
      properties: {
        provider: { enum: ['telegram', 'whatsapp', 'discord'] },
        chatId: { type: 'string', minLength: 1, maxLength: 256 },
        text: { type: 'string', minLength: 1 },
      },
    })
    expect(openapi.paths['/channels/claims'].post.responses).toHaveProperty('201')

    const verification = openapi.paths['/webhooks/whatsapp'].get
    expect(verification.security).toEqual([{ whatsappVerificationToken: [] }])
    expect(verification.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'hub.mode', required: true, schema: { type: 'string', const: 'subscribe' } }),
      expect.objectContaining({ name: 'hub.verify_token', required: true }),
      expect.objectContaining({ name: 'hub.challenge', required: true }),
    ]))
    expect(openapi.paths['/webhooks/whatsapp'].post.security).toEqual([{ whatsappSignature: [] }])
  })

  it('documents read-only alert inspection separately from operator evaluation', () => {
    expect(httpApi).toContain('`POST` | `/alerts/evaluate`')
    expect(openapi.paths['/alerts'].get['x-required-capability']).toBe('read')
    expect(openapi.paths['/alerts/evaluate'].post['x-required-capability']).toBe('operator')
    expect(openapi.paths['/alerts/evaluate'].post.responses).toHaveProperty('409')
  })

  it('documents dispatch acquisition recovery without exposing it as operator-tier', () => {
    expect(httpApi).toContain('`/dispatch-acquisitions/:dispatchId/:kind/settle`')
    expect(openapi.paths['/dispatch-acquisitions'].get['x-required-capability']).toBe('read')
    const settle = openapi.paths['/dispatch-acquisitions/{dispatchId}/{kind}/settle'].post
    expect(settle['x-required-capability']).toBe('admin')
    expect(settle.requestBody.content['application/json'].schema.properties.status.enum).toEqual(['released', 'failed'])
  })
})

function expectConditionalCapability(routePath: string, query: Record<string, boolean>): void {
  const openapi = JSON.parse(fs.readFileSync(path.join(root, 'docs/api/openapi.json'), 'utf-8'))
  expect(openapi.paths[routePath].get['x-conditional-capabilities']).toEqual(expect.arrayContaining([
    expect.objectContaining({
      when: { query },
      requiredCapability: 'admin',
    }),
  ]))
}
