import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import {
  FEATURE_VALUE_DECISION_POLICY,
  FEATURE_VALUE_DEFINITIONS,
  isFeatureValueEventInput,
  summarizeFeatureValueEvents,
} from '../packages/shared/src/feature-value-contract.ts'

const ADOPTION_SCHEMA = 'adoption/v2'

function parseRecords(source) {
  const trimmed = source.trim()
  if (!trimmed) return []
  if (trimmed.startsWith('[')) {
    const value = JSON.parse(trimmed)
    if (!Array.isArray(value)) throw new Error('Expected a JSON array or newline-delimited JSON records.')
    return value
  }
  return trimmed.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line)
    } catch {
      throw new Error(`Invalid JSON on input line ${index + 1}.`)
    }
  })
}

export function parseFeatureValueCollectorExport(source) {
  const records = parseRecords(source)
  const events = []
  let ignoredRecords = 0

  for (const record of records) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error('Collector records must be JSON objects.')
    }
    if (record.event !== 'feature.value') {
      ignoredRecords += 1
      continue
    }
    if (record.schema !== ADOPTION_SCHEMA || !isFeatureValueEventInput(record.props)) {
      // Never echo the record: a malformed collector export may contain the
      // content this reporting path is deliberately unable to process.
      throw new Error('Invalid adoption/v2 feature.value record.')
    }
    events.push(record.props)
  }

  return { records: records.length, ignoredRecords, events }
}

export function buildFeatureValueReview(parsed) {
  return {
    schema: ADOPTION_SCHEMA,
    sourceRecords: parsed.records,
    featureValueEvents: parsed.events.length,
    ignoredRecords: parsed.ignoredRecords,
    decisionPolicy: FEATURE_VALUE_DECISION_POLICY,
    rows: summarizeFeatureValueEvents(parsed.events).map((row) => ({
      ...row,
      ...FEATURE_VALUE_DEFINITIONS[row.feature],
    })),
  }
}

function percent(value) {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`
}

export function renderFeatureValueReview(review) {
  const lines = [
    `Feature value review (${review.schema})`,
    `Source records: ${review.sourceRecords}; feature-value events: ${review.featureValueEvents}; ignored non-feature records: ${review.ignoredRecords}`,
    `Automatic removal: disabled — ${review.decisionPolicy.reason}`,
    'Evidence quality: anonymous delivery is at-least-once; ratios are bounded observations, not unique-install cohort rates.',
    '',
    'Feature | Evidence | Discovered | Activated | Activation | Repeated | Repeat | Owner | Review date',
    '--- | --- | ---: | ---: | ---: | ---: | ---: | --- | ---',
  ]
  for (const row of review.rows) {
    lines.push([
      row.feature,
      row.evidence,
      row.discovered,
      row.activated,
      percent(row.activationRate),
      row.repeated,
      percent(row.repeatRate),
      row.owner,
      row.reviewDate,
    ].join(' | '))
  }
  return `${lines.join('\n')}\n`
}

function runCli() {
  const args = process.argv.slice(2)
  const json = args.includes('--json')
  const paths = args.filter((arg) => arg !== '--json' && arg !== '--')
  if (paths.length !== 1) {
    throw new Error('Usage: pnpm report:feature-value -- <collector.json|collector.ndjson|-> [--json]')
  }
  const source = readFileSync(paths[0] === '-' ? 0 : paths[0], 'utf8')
  const review = buildFeatureValueReview(parseFeatureValueCollectorExport(source))
  process.stdout.write(json ? `${JSON.stringify(review, null, 2)}\n` : renderFeatureValueReview(review))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runCli()
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
