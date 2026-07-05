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
// Estimates are deliberately conservative (worst case), so this sits well above
// the per-generator cap to leave headroom for legitimate dense charts (e.g. a
// ~4200-row fold across a dozen series lands near 50k) while still rejecting
// the multiplicative blow-ups (millions to billions of rows) long before they
// execute.
export const MAX_CHART_ESTIMATED_ROWS = 250_000

// Maximum number of grid cells a compute-heavy raster transform (contour,
// isocontour, heatmap) may declare. These transforms iterate every cell of a
// size[0] x size[1] grid but emit only a handful of output rows (polygons or a
// single image), so their cost is invisible to the row-count estimate above and
// needs its own bound. ~4M cells keeps legitimate density maps working while
// rejecting grids whose per-cell work would block the event loop.
export const MAX_CHART_GRID_CELLS = 4_000_000

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
// and return the implied PER-GROUP row count for the pipeline estimate. The
// caller multiplies this by the (bounded) group count when the transform has a
// `groupby`, since these generators run once per distinct group.
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

// True when a transform partitions its input by one or more group keys. groupby
// may be a field name, an array of fields, or a signal; any non-empty form runs
// the transform once per distinct group.
function hasGroupby(transform: Record<string, unknown>) {
  const groupby = transform.groupby
  if (Array.isArray(groupby)) return groupby.length > 0
  return groupby !== undefined && groupby !== null && groupby !== ''
}

// A generator/expander that runs per group emits `perGroup` rows for EVERY
// distinct group. The group count is data-dependent and opaque here, but every
// group requires at least one input row, so it is bounded by the stream's
// estimated input rows. Worst-case output is therefore perGroup * inputRows,
// which the caller caps against MAX_CHART_ESTIMATED_ROWS.
function amplifyPerGroup(perGroup: number, transform: Record<string, unknown>, inputRows: number) {
  if (!hasGroupby(transform)) return perGroup
  return perGroup * Math.max(1, inputRows)
}

// contour/isocontour/heatmap iterate every cell of a declared size[0] x size[1]
// grid. The output is a few polygons or a single image, so the row-count guard
// never sees the cost; bound the grid area directly instead. A non-numeric
// (e.g. signal) size cannot be bounded statically and is rejected outright, as
// with the other generator parameters.
function assertBoundedGridSize(type: string, transform: Record<string, unknown>) {
  const size = transform.size
  // Grids without a declared size derive their extent from input grid objects,
  // which are themselves bounded by the inline array-item cap; nothing to add.
  if (size === undefined) return
  if (!Array.isArray(size) || size.length < 2) {
    throw blockedRenderError(`${type} transform requires a static numeric [width, height] size`)
  }
  const width = toFiniteNumber(size[0])
  const height = toFiniteNumber(size[1])
  if (width === null || height === null || width < 0 || height < 0) {
    throw blockedRenderError(`${type} transform size must be finite, non-negative numbers`)
  }
  const cells = width * height
  if (cells > MAX_CHART_GRID_CELLS) {
    throw blockedRenderError(
      `${type} transform would compute a ${cells}-cell grid (max ${MAX_CHART_GRID_CELLS} cells)`,
    )
  }
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
        rows = Math.max(rows, amplifyPerGroup(boundedSequenceRowCount(transform), transform, rows))
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
        rows = Math.max(rows, amplifyPerGroup(boundedGeneratorRowCount(type, transform), transform, rows))
        break
      case 'impute': {
        // impute materializes a full (key x groupby) grid, filling every
        // missing combination. Output rows = distinct(key) * distinct(groupby);
        // both distinct counts are data-dependent but bounded by the input row
        // count. Without a groupby there is a single group and no blow-up; with
        // one, the worst case is inputRows^2, which the cap below rejects.
        const factor = hasGroupby(transform) ? Math.max(1, rows) : 1
        rows = Math.max(rows, rows * factor)
        break
      }
      case 'contour':
      case 'isocontour':
      case 'heatmap':
        assertBoundedGridSize(type, transform)
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
