export function isFullVegaSpec(spec: Record<string, unknown>): boolean {
  const schema = typeof spec?.$schema === 'string' ? spec.$schema : ''
  return schema.includes('/vega/v') && !schema.includes('/vega-lite/')
}

export function normalizeVegaSpecSchema(spec: Record<string, unknown>): Record<string, unknown> {
  const schema = typeof spec?.$schema === 'string' ? spec.$schema : ''
  if (!schema.includes('/vega-lite/')) return spec

  const normalizedSchema = schema.replace(/\/vega-lite\/v\d+(?:\.\d+)?\.json$/, '/vega-lite/v6.json')
  if (normalizedSchema === schema) return spec

  return {
    ...spec,
    $schema: normalizedSchema,
  }
}
