import assert from 'node:assert/strict'

const anySymbol = Symbol('gateway.expect.any')
const objectContainingSymbol = Symbol('gateway.expect.objectContaining')

type AnyMatcher = { readonly [anySymbol]: unknown }
type ObjectContainingMatcher = { readonly [objectContainingSymbol]: Record<string, unknown> }

function isAnyMatcher(value: unknown): value is AnyMatcher {
  return typeof value === 'object' && value !== null && anySymbol in value
}

function isObjectContainingMatcher(value: unknown): value is ObjectContainingMatcher {
  return typeof value === 'object' && value !== null && objectContainingSymbol in value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function matchesExpected(actual: unknown, expected: unknown): boolean {
  if (isAnyMatcher(expected)) {
    const expectedType = expected[anySymbol]
    if (expectedType === String) return typeof actual === 'string'
    if (expectedType === Number) return typeof actual === 'number'
    if (expectedType === Boolean) return typeof actual === 'boolean'
    if (expectedType === Object) return isRecord(actual)
    if (expectedType === Array) return Array.isArray(actual)
    if (typeof expectedType === 'function') return actual instanceof expectedType
    return false
  }

  if (isObjectContainingMatcher(expected)) {
    return objectMatches(actual, expected[objectContainingSymbol])
  }

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false
    return expected.every((item, index) => matchesExpected(actual[index], item))
  }

  if (isRecord(expected)) {
    if (!isRecord(actual)) return false
    const expectedEntries = Object.entries(expected)
    return expectedEntries.every(([key, value]) => matchesExpected(actual[key], value))
  }

  return Object.is(actual, expected)
}

function objectMatches(actual: unknown, expected: Record<string, unknown>): boolean {
  if (!isRecord(actual)) return false
  return Object.entries(expected).every(([key, value]) => matchesExpected(actual[key], value))
}

function assertMatchObject(actual: unknown, expected: Record<string, unknown>) {
  if (!objectMatches(actual, expected)) {
    assert.fail(`Expected object to match subset:\nactual=${JSON.stringify(actual)}\nexpected=${JSON.stringify(expected)}`)
  }
}

function assertMatchesExpected(actual: unknown, expected: unknown) {
  if (!matchesExpected(actual, expected)) {
    assert.fail(`Expected values to match:\nactual=${JSON.stringify(actual)}\nexpected=${JSON.stringify(expected)}`)
  }
}

function thrownMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function assertThrown(error: unknown, expected?: string | RegExp) {
  if (expected === undefined) return
  const message = thrownMessage(error)
  if (typeof expected === 'string') assert.match(message, new RegExp(escapeRegExp(expected)))
  else assert.match(message, expected)
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function expect(actual: unknown) {
  const base = {
    toBe(expected: unknown) {
      assert.equal(actual, expected)
    },
    toEqual(expected: unknown) {
      if (containsMatcher(expected)) assertMatchesExpected(actual, expected)
      else assert.deepEqual(actual, expected)
    },
    toMatchObject(expected: Record<string, unknown>) {
      assertMatchObject(actual, expected)
    },
    toMatch(expected: RegExp) {
      assert.match(String(actual), expected)
    },
    toContain(expected: string) {
      assert.ok(String(actual).includes(expected), `Expected ${String(actual)} to contain ${expected}`)
    },
    toBeGreaterThan(expected: number) {
      assert.ok(Number(actual) > expected, `Expected ${String(actual)} to be greater than ${expected}`)
    },
    toBeLessThanOrEqual(expected: number) {
      assert.ok(Number(actual) <= expected, `Expected ${String(actual)} to be <= ${expected}`)
    },
    toBeTruthy() {
      assert.ok(actual)
    },
    toBeNull() {
      assert.equal(actual, null)
    },
    toHaveLength(expected: number) {
      assert.equal((actual as { length?: unknown }).length, expected)
    },
    toThrow(expected?: string | RegExp) {
      assert.equal(typeof actual, 'function')
      let thrown: unknown
      try {
        ;(actual as () => unknown)()
      } catch (error) {
        thrown = error
      }
      assert.notEqual(thrown, undefined, 'Expected function to throw')
      assertThrown(thrown, expected)
    },
    get not() {
      return {
        toContain(expected: string) {
          assert.ok(!String(actual).includes(expected), `Expected ${String(actual)} not to contain ${expected}`)
        },
        toThrow(expected?: string | RegExp) {
          assert.equal(typeof actual, 'function')
          try {
            ;(actual as () => unknown)()
          } catch (error) {
            if (expected === undefined) assert.fail(`Expected function not to throw: ${thrownMessage(error)}`)
            const message = thrownMessage(error)
            if (typeof expected === 'string') assert.doesNotMatch(message, new RegExp(escapeRegExp(expected)))
            else assert.doesNotMatch(message, expected)
          }
        },
      }
    },
    get resolves() {
      const promise = Promise.resolve(actual)
      return {
        async toBe(expected: unknown) {
          assert.equal(await promise, expected)
        },
        async toMatchObject(expected: Record<string, unknown>) {
          assertMatchObject(await promise, expected)
        },
      }
    },
    get rejects() {
      const promise = Promise.resolve(actual)
      return {
        async toThrow(expected?: string | RegExp) {
          let thrown: unknown
          try {
            await promise
          } catch (error) {
            thrown = error
          }
          assert.notEqual(thrown, undefined, 'Expected promise to reject')
          assertThrown(thrown, expected)
        },
      }
    },
  }
  return base
}

function containsMatcher(value: unknown): boolean {
  if (isAnyMatcher(value) || isObjectContainingMatcher(value)) return true
  if (Array.isArray(value)) return value.some(containsMatcher)
  if (isRecord(value)) return Object.values(value).some(containsMatcher)
  return false
}

expect.any = (type: unknown): AnyMatcher => ({ [anySymbol]: type })
expect.objectContaining = (expected: Record<string, unknown>): ObjectContainingMatcher => ({
  [objectContainingSymbol]: expected,
})
