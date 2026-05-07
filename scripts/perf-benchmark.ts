import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareReports, hasComparableEnvironment } from './perf/compare.ts'
import { aggregateReports, formatLine } from './perf/report.ts'
import { runSessionBenchmarks } from './perf/suite.ts'
import type { BenchmarkReport } from './perf/types.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASELINE_PATH = resolve(__dirname, '../benchmarks/perf-baseline.json')

function writeStdout(line = '') {
  process.stdout.write(`${line}\n`)
}

function writeStderr(line = '') {
  process.stderr.write(`${line}\n`)
}

function printReport(report: BenchmarkReport) {
  writeStdout(`Perf benchmark report (${report.environment.platform}/${report.environment.arch} ${report.environment.node})`)
  for (const result of report.benchmarks) {
    writeStdout(formatLine(result))
  }
}

async function main() {
  const args = new Set(process.argv.slice(2))
  const shouldWrite = args.has('--write')
  const shouldCheck = args.has('--check')
  const suiteRuns = shouldCheck || shouldWrite ? 5 : 1
  const reports: BenchmarkReport[] = []

  for (let runIndex = 0; runIndex < suiteRuns; runIndex += 1) {
    reports.push(await runSessionBenchmarks())
  }

  const report = aggregateReports(reports)
  printReport(report)

  if (shouldWrite) {
    mkdirSync(dirname(BASELINE_PATH), { recursive: true })
    writeFileSync(BASELINE_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    writeStdout(`\nWrote baseline to ${BASELINE_PATH}`)
  }

  if (shouldCheck) {
    const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as BenchmarkReport
    if (!hasComparableEnvironment(report, baseline)) {
      writeStdout(
        `\nPerf baseline environment differs (${baseline.environment.platform}/${baseline.environment.arch} ${baseline.environment.node}); using cross-environment absolute floors.`,
      )
    }
    const failures = compareReports(report, baseline)
    if (failures.length > 0) {
      writeStderr('\nPerf regression detected:')
      for (const failure of failures) {
        writeStderr(`- ${failure}`)
      }
      process.exitCode = 1
      return
    }
    writeStdout('\nPerf check passed against baseline.')
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error)
  writeStderr(message)
  process.exitCode = 1
})
