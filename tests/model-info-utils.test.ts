import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ModelInfoSnapshot } from '../packages/shared/src/index.ts'
import { buildModelInfoSnapshot } from '../apps/desktop/src/main/model-info-utils.ts'

const emptyFallbacks: ModelInfoSnapshot = { pricing: {}, contextLimits: {} }

describe('buildModelInfoSnapshot', () => {
  it('returns the fallbacks verbatim when the provider list is empty', () => {
    const fallbacks: ModelInfoSnapshot = {
      pricing: { 'acme/alpha': { inputPer1M: 3, outputPer1M: 15 } },
      contextLimits: { 'acme/alpha': 200_000 },
    }
    const snap = buildModelInfoSnapshot([], fallbacks)
    assert.deepEqual(snap, fallbacks)
    // Returned object should be a fresh copy so callers can mutate safely.
    assert.notStrictEqual(snap.pricing, fallbacks.pricing)
    assert.notStrictEqual(snap.contextLimits, fallbacks.contextLimits)
  })

  it('overlays provider pricing on top of fallbacks', () => {
    const fallbacks: ModelInfoSnapshot = {
      pricing: { 'acme/alpha': { inputPer1M: 1, outputPer1M: 2 } },
      contextLimits: { 'acme/alpha': 100_000 },
    }
    const snap = buildModelInfoSnapshot([
      {
        id: 'acme',
        models: {
          'alpha': { cost: { input: 3, output: 15, cache: { read: 0.5, write: 1 } }, limit: { context: 200_000 } },
          'acme/beta': { cost: { input: 5, output: 20 }, limit: { context: 128_000 } },
        },
      },
    ], fallbacks)
    assert.deepEqual(snap.pricing['acme/alpha'], { inputPer1M: 3, outputPer1M: 15, cachePer1M: 0.5, cacheWritePer1M: 1 })
    assert.deepEqual(snap.pricing.alpha, { inputPer1M: 3, outputPer1M: 15, cachePer1M: 0.5, cacheWritePer1M: 1 })
    assert.deepEqual(snap.pricing['acme/beta'], { inputPer1M: 5, outputPer1M: 20 })
    assert.equal(snap.contextLimits['acme/alpha'], 200_000)
    assert.equal(snap.contextLimits.alpha, 200_000)
    assert.equal(snap.contextLimits['acme/beta'], 128_000)
  })

  it('keeps fallback pricing when provider cost fields are all zero', () => {
    const fallbacks: ModelInfoSnapshot = {
      pricing: { 'acme/alpha': { inputPer1M: 3, outputPer1M: 15 } },
      contextLimits: {},
    }
    const snap = buildModelInfoSnapshot([
      { models: { 'acme/alpha': { cost: { input: 0, output: 0 }, limit: {} } } },
    ], fallbacks)
    assert.deepEqual(snap.pricing['acme/alpha'], { inputPer1M: 3, outputPer1M: 15 })
  })

  it('overlays provider pricing when only cache write cost is positive', () => {
    const snap = buildModelInfoSnapshot([
      {
        id: 'acme',
        models: {
          alpha: { cost: { input: 0, output: 0, cache: { write: 2 } } },
        },
      },
    ], emptyFallbacks)

    assert.deepEqual(snap.pricing['acme/alpha'], {
      inputPer1M: 0,
      outputPer1M: 0,
      cacheWritePer1M: 2,
    })
  })

  it('keeps fallback pricing when the provider omits a cost block entirely', () => {
    const fallbacks: ModelInfoSnapshot = {
      pricing: { 'acme/alpha': { inputPer1M: 3, outputPer1M: 15 } },
      contextLimits: {},
    }
    const snap = buildModelInfoSnapshot([
      { models: { 'acme/alpha': { limit: { context: 32_000 } } } },
    ], fallbacks)
    assert.deepEqual(snap.pricing['acme/alpha'], { inputPer1M: 3, outputPer1M: 15 })
    assert.equal(snap.contextLimits['acme/alpha'], 32_000)
  })

  it('ignores non-numeric cost fields without corrupting the output', () => {
    const snap = buildModelInfoSnapshot([
      {
        models: {
          'acme/alpha': { cost: { input: 'nope' as unknown as number, output: 5 } },
        },
      },
    ], emptyFallbacks)
    assert.deepEqual(snap.pricing['acme/alpha'], { inputPer1M: 0, outputPer1M: 5 })
  })

  it('tolerates providers with null or missing models maps', () => {
    const snap = buildModelInfoSnapshot([
      { models: null },
      { models: undefined },
      {},
    ], {
      pricing: { 'acme/alpha': { inputPer1M: 1, outputPer1M: 2 } },
      contextLimits: { 'acme/alpha': 1000 },
    })
    assert.equal(snap.pricing['acme/alpha'].inputPer1M, 1)
    assert.equal(snap.contextLimits['acme/alpha'], 1000)
  })
})
