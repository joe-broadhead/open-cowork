import { MAX_CHART_ARRAY_ITEMS } from '@open-cowork/shared'

// Static cardinality guard for untrusted chart specs (audit issue #865).
//
// renderChartSpecToSvg races view.toSVG() against a timeout, but Vega's
// dataflow and expression evaluation are SYNCHRONOUS and CPU-bound: once
// vega.parse / view evaluation starts, the main-process event loop is blocked
// and the timeout callback can never fire. The shared validateInlineChartSpec
// only bounds the INPUT (bytes / array items / depth), so a tiny spec using a
// generative transform (e.g. `sequence` with stop 1e9) or an amplifying one
// (`cross`, chained `fold`) can expand far past every input cap and block or
// OOM-crash the whole app.
//
// This module statically estimates the OUTPUT cardinality of every data
// pipeline in the compiled Vega spec and rejects specs whose derived row
// counts cannot be bounded to a safe size. It must run on the full Vega spec
// (after vega-lite compilation, which is purely symbolic and does not evaluate
// data) and BEFORE vega.parse, while the event loop is still responsive.

// Maximum rows a single generator (sequence, density steps, quantile steps)
// may produce. Matches the shared MAX_CHART_ARRAY_ITEMS input cap so generated
// data is never allowed to exceed what inline data is allowed to provide.
export const MAX_CHART_GENERATED_ROWS = 20_000

// Maximum estimated rows any single data pipeline may reach after transforms.
// Estimates are deliberately conservative (worst case), so this sits above the
// per-generator cap to leave headroom for legitimate fold/flatten usage while
// still rejecting multiplicative blow-ups long before they execute.
export const MAX_CHART_ESTIMATED_ROWS = 50_000

function blockedRenderError(detail: string) {
  return new Error(`Chart rendering rejected an unsafe or oversized spec: ${detail}`)
}

function toFiniteNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

interface DataCardinalityEstimate {
  rows: number
  // Product of row-duplication factors (fold) applied while deriving the
  // dataset. Used to bound flatten output, whose row count is limited by the
  // spec-wide inline array-item cap times any duplication that ran before it.
  duplication: number
}

// `sequence` materializes ceil((stop - start) / step) rows from constant-size
// input. Non-numeric parameters (e.g. { signal: ... } expressions) cannot be
// bounded statically, so they are rejected outright for untrusted specs.
function boundedSequenceRowCount(transform: Record<string, unknown>) {
  const start = transform.start === undefined ? 0 : toFiniteNumber(transform.start)
  const stop = toFiniteNumber(transform.stop)
  const step = transform.step === undefined ? 1 : toFiniteNumber(transform.step)
  if (start === null || stop === null || step === null || step === 0) {
    throw blockedRenderError('sequence transforms require finite numeric start/stop/step values')
  }
  const rows = Math.max(0, Math.ceil((stop - start) / step))
  if (rows > MAX_CHART_GENERATED_ROWS) {
    throw blockedRenderError(`sequence transform would generate ${rows} rows (max ${MAX_CHART_GENERATED_ROWS})`)
  }
  return rows
}

// density/kde generate `steps` samples per group; quantile generates ~1/step
// probabilities. Cap the step-count parameters so they cannot be used as row
// generators (their defaults are tiny, so legitimate specs are unaffected),
// and return the implied per-group row count for the pipeline estimate.
// Note: per-group amplification (groupby * steps) is not modeled; steps alone
// is capped, which removes the constant-input blow-up these generators allow.
function boundedGeneratorRowCount(type: string, transform: Record<string, unknown>) {
  if (type === 'density' || type === 'kde') {
    // Vega defaults: minsteps 25, maxsteps 200.
    let steps = 200
    for (const key of ['steps', 'minsteps', 'maxsteps']) {
      if (transform[key] === undefined) continue
      const value = toFiniteNumber(transform[key])
      if (value === null || value > MAX_CHART_GENERATED_ROWS) {
        throw blockedRenderError(`${type} transform ${key} must be a finite number of at most ${MAX_CHART_GENERATED_ROWS}`)
      }
      steps = Math.max(steps, value)
    }
    return steps
  }
  // quantile: probs array length is already input-capped; step implies ~1/step.
  if (transform.step !== undefined) {
    const step = toFiniteNumber(transform.step)
    if (step === null || step <= 0 || 1 / step > MAX_CHART_GENERATED_ROWS) {
      throw blockedRenderError(`quantile transform step implies more than ${MAX_CHART_GENERATED_ROWS} rows`)
    }
    return Math.ceil(1 / step)
  }
  return Array.isArray(transform.probs) ? transform.probs.length : 100
}

function estimateDataPipeline(
  dataset: Record<string, unknown>,
  estimates: Map<string, DataCardinalityEstimate>,
): DataCardinalityEstimate {
  let rows = 0
  let duplication = 1

  if (Array.isArray(dataset.values)) {
    rows = dataset.values.length
  } else if (typeof dataset.source === 'string') {
    // Unknown sources (forward references) fall back to the input array-item
    // cap so amplification on top of them is still bounded conservatively.
    const sourceEstimate = estimates.get(dataset.source)
    rows = sourceEstimate ? sourceEstimate.rows : MAX_CHART_ARRAY_ITEMS
    duplication = sourceEstimate ? sourceEstimate.duplication : 1
  } else if (Array.isArray(dataset.source)) {
    for (const name of dataset.source) {
      const sourceEstimate = typeof name === 'string' ? estimates.get(name) : undefined
      rows += sourceEstimate ? sourceEstimate.rows : MAX_CHART_ARRAY_ITEMS
      duplication = Math.max(duplication, sourceEstimate ? sourceEstimate.duplication : 1)
    }
  }
  // Datasets with neither values nor source start empty: url loads are already
  // blocked by the restricted loader, so only generator transforms add rows.

  const transforms = Array.isArray(dataset.transform) ? dataset.transform : []
  for (const entry of transforms) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const transform = entry as Record<string, unknown>
    const type = typeof transform.type === 'string' ? transform.type.toLowerCase() : ''

    switch (type) {
      case 'sequence':
        rows = Math.max(rows, boundedSequenceRowCount(transform))
        break
      case 'cross':
        // Cartesian product: output is |left| * |right|, which cannot be
        // bounded statically and reaches ~4e8 rows even within the input caps.
        throw blockedRenderError('cross transforms are not allowed')
      case 'graticule':
        // Geographic grid generator: sub-degree step/precision parameters
        // imply millions of points from a constant-size spec, and map specs
        // need external topology data the restricted loader blocks anyway.
        throw blockedRenderError('graticule transforms are not allowed')
      case 'fold': {
        // fold emits one row per field per input row.
        const fields = transform.fields
        if (!Array.isArray(fields)) {
          throw blockedRenderError('fold transforms require a static fields array')
        }
        rows *= Math.max(1, fields.length)
        duplication *= Math.max(1, fields.length)
        break
      }
      case 'flatten':
        // flatten emits one row per array element. Element counts are opaque
        // here, but every inline array item in the spec is capped by
        // MAX_CHART_ARRAY_ITEMS, so worst-case output is that cap times any
        // fold duplication applied earlier in the derivation chain.
        rows = Math.max(rows, duplication * MAX_CHART_ARRAY_ITEMS)
        break
      case 'density':
      case 'kde':
      case 'quantile':
        rows = Math.max(rows, boundedGeneratorRowCount(type, transform))
        break
      default:
        // Remaining transforms (filter, aggregate, stack, formula, ...) do not
        // increase row counts beyond what is already estimated.
        break
    }

    if (rows > MAX_CHART_ESTIMATED_ROWS) {
      throw blockedRenderError(
        `derived data would reach an estimated ${rows} rows (max ${MAX_CHART_ESTIMATED_ROWS}); reduce generated or folded data`,
      )
    }
  }

  return { rows, duplication }
}

// Walks a compiled (full) Vega spec and bounds the estimated output rows of
// every data pipeline, including datasets nested inside group marks. Call this
// AFTER vega-lite compilation and BEFORE vega.parse: parse/evaluation is the
// synchronous, uninterruptible step this guard exists to protect.
export function assertBoundedVegaSpecCardinality(spec: Record<string, unknown>) {
  const estimates = new Map<string, DataCardinalityEstimate>()

  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item)
      return
    }
    if (!node || typeof node !== 'object') return
    const record = node as Record<string, unknown>

    if (Array.isArray(record.data)) {
      // Vega requires datasets to be declared before they are referenced, so
      // evaluating in document order lets `source` references resolve to the
      // estimates computed for their upstream datasets.
      for (const entry of record.data) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
        const dataset = entry as Record<string, unknown>
        const estimate = estimateDataPipeline(dataset, estimates)
        if (typeof dataset.name === 'string') {
          estimates.set(dataset.name, estimate)
        }
      }
    }

    for (const child of Object.values(record)) visit(child)
  }

  visit(spec)
}
