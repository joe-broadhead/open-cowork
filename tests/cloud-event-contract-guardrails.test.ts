import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import {
  CLOUD_PROJECTED_SESSION_EVENT_TYPES,
  CLOUD_SESSION_EVENT_TYPES,
  isCloudProjectedSessionEventType,
  isCloudSessionEventType,
} from '../packages/shared/dist/cloud-session-projection.js'

const root = process.cwd()
const cloudRoot = join(root, 'packages/cloud-server/src')
const httpServerSource = readFileSync(join(cloudRoot, 'http-server.ts'), 'utf8')

const projectionReducingEventTypes = [
  'session.created',
  'session.imported',
  'session.project_source.bound',
  'prompt.submitted',
  'assistant.message',
  'tool.call',
  'task.run',
  'permission.requested',
  'permission.resolved',
  'question.asked',
  'question.resolved',
  'todos.updated',
  'cost.updated',
  'artifact.created',
  'artifact.updated',
  'session.status',
  'session.idle',
  'session.aborted',
  'runtime.error',
] as const

const transportOnlyEventTypes = [
  'snapshot.required',
  'channel.delivery',
] as const

test('canonical cloud event contract classifies every event type explicitly', () => {
  const classified = new Set([
    ...projectionReducingEventTypes,
    ...transportOnlyEventTypes,
  ])
  assert.deepEqual([...classified].sort(), [...CLOUD_SESSION_EVENT_TYPES].sort())
  assert.deepEqual([...projectionReducingEventTypes].sort(), [...CLOUD_PROJECTED_SESSION_EVENT_TYPES].sort())

  for (const type of projectionReducingEventTypes) {
    assert.equal(isCloudSessionEventType(type), true, `${type} must remain a canonical cloud session event`)
    assert.equal(isCloudProjectedSessionEventType(type), true, `${type} must remain a projected cloud session event`)
  }
  for (const type of transportOnlyEventTypes) {
    assert.equal(isCloudSessionEventType(type), true, `${type} must remain a canonical transport/session event`)
    assert.equal(isCloudProjectedSessionEventType(type), false, `${type} must not enter projection persistence`)
  }
})

test('cloud projected event literals use the canonical shared event contract', () => {
  const offenders: string[] = []
  for (const file of sourceFiles(cloudRoot)) {
    const source = readFileSync(file, 'utf8')
    for (const eventType of projectedEventLiterals(source)) {
      if (!isCloudProjectedSessionEventType(eventType)) {
        offenders.push(`${relative(root, file)} -> ${eventType}`)
      }
    }
  }
  assert.deepEqual(offenders, [])
})

test('cloud SSE emitter literals use the canonical shared event contract', () => {
  const offenders = sseEventLiterals(httpServerSource)
    .filter((eventType) => !isCloudSessionEventType(eventType))
  assert.deepEqual(offenders, [])
  assert.doesNotMatch(
    httpServerSource,
    /res\.write\(['"`]event:\s*[a-z.]+\\n['"`]\)/,
    'SSE event names must be written through typed constants or writeSseEvent',
  )
})

function projectedEventLiterals(source: string): string[] {
  const matches: string[] = []
  const eventCallPattern = /append(?:Projected|Product)Event\(\s*\{[\s\S]*?type:\s*['"]([^'"]+)['"]/g
  let match: RegExpExecArray | null
  while ((match = eventCallPattern.exec(source))) {
    matches.push(match[1])
  }
  return matches
}

function sseEventLiterals(source: string): string[] {
  const matches: string[] = []
  const eventCallPattern = /writeSseEvent\([^,]+,\s*\{[\s\S]*?type:\s*['"]([^'"]+)['"]/g
  let match: RegExpExecArray | null
  while ((match = eventCallPattern.exec(source))) {
    matches.push(match[1])
  }
  return matches
}

function sourceFiles(directory: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory)) {
    if (entry === 'dist' || entry === 'node_modules') continue
    const path = join(directory, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) files.push(...sourceFiles(path))
    else if (path.endsWith('.ts') && !path.endsWith('.test.ts')) files.push(path)
  }
  return files
}
