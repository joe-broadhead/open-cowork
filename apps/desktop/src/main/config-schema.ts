import electron from 'electron'
import Ajv2020 from 'ajv/dist/2020.js'
import type { ErrorObject } from 'ajv'
import { existsSync, readFileSync } from 'fs'
import { join, resolve } from 'path'

const electronApp = (electron as { app?: typeof import('electron').app }).app

type JsonSchemaNode = {
  required?: string[]
  properties?: Record<string, JsonSchemaNode>
  items?: JsonSchemaNode
  additionalProperties?: boolean | JsonSchemaNode
  $defs?: Record<string, JsonSchemaNode>
  [key: string]: unknown
}

function cloneSchemaWithoutRequired(node: JsonSchemaNode): JsonSchemaNode {
  return {
    ...node,
    required: undefined,
    properties: node.properties
      ? Object.fromEntries(
          Object.entries(node.properties).map(([key, value]) => [key, cloneSchemaWithoutRequired(value)]),
        )
      : undefined,
    items: node.items ? cloneSchemaWithoutRequired(node.items) : undefined,
    additionalProperties: typeof node.additionalProperties === 'object' && node.additionalProperties
      ? cloneSchemaWithoutRequired(node.additionalProperties)
      : node.additionalProperties,
    $defs: node.$defs
      ? Object.fromEntries(
          Object.entries(node.$defs).map(([key, value]) => [key, cloneSchemaWithoutRequired(value)]),
        )
      : undefined,
  }
}

function resolveSchemaPath() {
  const candidates = [
    process.resourcesPath ? join(process.resourcesPath, 'open-cowork.config.schema.json') : null,
    typeof __dirname === 'string' ? resolve(__dirname, '../../../../open-cowork.config.schema.json') : null,
    electronApp?.getAppPath ? resolve(electronApp.getAppPath(), '..', '..', 'open-cowork.config.schema.json') : null,
    resolve(process.cwd(), 'open-cowork.config.schema.json'),
  ].filter((value): value is string => Boolean(value))

  return candidates.find((candidate) => existsSync(candidate)) || candidates[candidates.length - 1]
}

function createValidator(schema: JsonSchemaNode) {
  const ajv = new Ajv2020({
    allErrors: true,
    allowUnionTypes: true,
    strict: false,
  })
  return ajv.compile(schema)
}

function formatPath(instancePath: string, missingProperty?: string) {
  const normalized = instancePath
    .replace(/\//g, '.')
    .replace(/^\./, '')
    .replace(/\.(\d+)(?=\.|$)/g, '[$1]')
  const path = missingProperty
    ? normalized
      ? `${normalized}.${missingProperty}`
      : missingProperty
    : normalized
  return path || '(root)'
}

function formatSchemaError(error: ErrorObject) {
  const details = (error.params && typeof error.params === 'object')
    ? error.params as Record<string, unknown>
    : {}

  switch (error.keyword) {
    case 'required':
      return `${formatPath(error.instancePath, typeof details.missingProperty === 'string' ? details.missingProperty : undefined)} is required`
    case 'additionalProperties':
      return `${formatPath(error.instancePath, typeof details.additionalProperty === 'string' ? details.additionalProperty : undefined)} is not allowed`
    case 'enum': {
      const allowed = Array.isArray(details.allowedValues) ? details.allowedValues.join(', ') : 'allowed values'
      return `${formatPath(error.instancePath)} must be one of: ${allowed}`
    }
    case 'type': {
      const expected = Array.isArray(details.type) ? details.type.join(' or ') : String(details.type || 'the expected type')
      return `${formatPath(error.instancePath)} must be ${expected}`
    }
    case 'minimum':
      return `${formatPath(error.instancePath)} must be >= ${details.limit}`
    default:
      return error.message
        ? `${formatPath(error.instancePath)} ${error.message}`
        : `${formatPath(error.instancePath)} is invalid`
  }
}

function validateConfig(
  value: unknown,
  validator: ReturnType<typeof createValidator>,
  source: string,
) {
  const ok = validator(value)
  if (ok) return
  const message = formatSchemaError(validator.errors?.[0] || {
    keyword: 'invalid',
    instancePath: '',
    schemaPath: '',
    params: {},
  } as ErrorObject)
  throw new Error(`Invalid Open Cowork config in ${source}: ${message}`)
}

const fullConfigSchema = JSON.parse(readFileSync(resolveSchemaPath(), 'utf-8')) as JsonSchemaNode
const partialConfigSchema = cloneSchemaWithoutRequired(fullConfigSchema)
const validateFullConfig = createValidator(fullConfigSchema)
const validatePartialConfig = createValidator(partialConfigSchema)

export function validateConfigLayerInput(value: unknown, source: string) {
  if (value === undefined || value === null) return
  validateConfig(value, validatePartialConfig, source)
}

export function validateResolvedConfig(value: unknown, source: string) {
  validateConfig(value, validateFullConfig, source)
}
