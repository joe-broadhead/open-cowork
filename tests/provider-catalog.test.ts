import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mapResponseToModels } from '../apps/desktop/src/main/provider-catalog.ts'

describe('mapResponseToModels', () => {
  it('returns empty for non-object bodies', () => {
    assert.deepEqual(mapResponseToModels(null, { url: 'x' }), [])
    assert.deepEqual(mapResponseToModels(123, { url: 'x' }), [])
    assert.deepEqual(mapResponseToModels('oops', { url: 'x' }), [])
  })

  it('returns empty when the configured responsePath is missing', () => {
    const result = mapResponseToModels(
      { models: [] },
      { url: 'x', responsePath: 'data' },
    )
    assert.deepEqual(result, [])
  })

  it('parses OpenRouter-shaped responses with default fields', () => {
    const body = {
      data: [
        { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4', description: 'top', context_length: 1_000_000 },
        { id: 'openai/gpt-5', name: 'GPT-5', context_length: 400_000 },
      ],
    }
    const result = mapResponseToModels(body, {
      url: 'https://example.com',
      responsePath: 'data',
      contextLengthField: 'context_length',
    })
    assert.equal(result.length, 2)
    assert.equal(result[0].id, 'anthropic/claude-sonnet-4')
    assert.equal(result[0].name, 'Claude Sonnet 4')
    assert.equal(result[0].description, 'top')
    assert.equal(result[0].contextLength, 1_000_000)
    assert.equal(result[1].description, undefined)
  })

  it('accepts a bare array when responsePath is omitted', () => {
    // Providers that return the array at the root of the body — no
    // wrapping `{ data: [...] }` — don't need a responsePath.
    const result = mapResponseToModels([
      { id: 'a', name: 'Alpha' },
      { id: 'b', name: 'Beta' },
    ], { url: 'x' })
    assert.equal(result.length, 2)
    assert.equal(result[0].id, 'a')
    assert.equal(result[1].id, 'b')
  })

  it('skips entries without an id', () => {
    const body = {
      data: [
        { id: '', name: 'Nameless' },
        { name: 'NoId' },
        { id: 'valid', name: 'Valid' },
      ],
    }
    const result = mapResponseToModels(body, {
      url: 'x',
      responsePath: 'data',
    })
    assert.equal(result.length, 1)
    assert.equal(result[0].id, 'valid')
  })

  it('falls back to id when name is missing', () => {
    const body = { data: [{ id: 'only-id' }] }
    const result = mapResponseToModels(body, { url: 'x', responsePath: 'data' })
    assert.equal(result[0].name, 'only-id')
  })

  it('honors custom field names', () => {
    const body = {
      models: [
        { model_id: 'alpha', display: 'Alpha Pro', summary: 'fast', window: 8192 },
      ],
    }
    const result = mapResponseToModels(body, {
      url: 'x',
      responsePath: 'models',
      idField: 'model_id',
      nameField: 'display',
      descriptionField: 'summary',
      contextLengthField: 'window',
    })
    assert.equal(result.length, 1)
    assert.equal(result[0].id, 'alpha')
    assert.equal(result[0].name, 'Alpha Pro')
    assert.equal(result[0].description, 'fast')
    assert.equal(result[0].contextLength, 8192)
  })

  it('supports dotted responsePath for nested arrays', () => {
    const body = { result: { catalog: [{ id: 'x', name: 'X' }] } }
    const result = mapResponseToModels(body, {
      url: 'x',
      responsePath: 'result.catalog',
    })
    assert.equal(result.length, 1)
    assert.equal(result[0].id, 'x')
  })

  it('ignores non-array values at the responsePath', () => {
    const body = { data: { not: 'an-array' } }
    assert.deepEqual(mapResponseToModels(body, { url: 'x', responsePath: 'data' }), [])
  })

  it('handles non-finite context_length gracefully', () => {
    const body = { data: [{ id: 'a', name: 'A', context_length: Number.POSITIVE_INFINITY }] }
    const result = mapResponseToModels(body, { url: 'x', responsePath: 'data' })
    assert.equal(result[0].contextLength, undefined)
  })
})
