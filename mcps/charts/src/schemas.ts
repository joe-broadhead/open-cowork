import { z } from 'zod'

export const chartDataSchema = z.array(
  z.record(z.string(), z.unknown()),
).describe('Array of data objects')

export const vegaLiteSpecSchema = z.record(
  z.string(),
  z.unknown(),
).describe('Full Vega-Lite specification object')
