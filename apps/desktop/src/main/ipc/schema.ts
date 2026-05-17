import type { IpcMainInvokeEvent } from 'electron'
import type { IpcHandlerContext } from './context.ts'

export type IpcArgsSchema<TArgs extends unknown[]> = {
  parse(channel: string, args: unknown[]): TArgs
}

type IpcInvokeHandler<TArgs extends unknown[], TResult> = (
  event: IpcMainInvokeEvent,
  ...args: TArgs
) => TResult | Promise<TResult>

function createIpcArgsSchema<TArgs extends unknown[]>(
  parse: (channel: string, args: unknown[]) => TArgs,
): IpcArgsSchema<TArgs> {
  return { parse }
}

export function registerIpcInvoke<TArgs extends unknown[], TResult>(
  context: IpcHandlerContext,
  channel: string,
  argsSchema: IpcArgsSchema<TArgs>,
  handler: IpcInvokeHandler<TArgs, TResult>,
) {
  context.ipcMain.handle(channel, async (event, ...rawArgs) => {
    const args = argsSchema.parse(channel, rawArgs)
    return handler(event as IpcMainInvokeEvent, ...args)
  })
}

export const noIpcArgs = createIpcArgsSchema<[]>((channel, args) => {
  if (args.length !== 0) {
    throw new Error(`${channel} does not accept arguments.`)
  }
  return []
})

export function stringArg(label: string, options: { optional?: false; maxBytes?: number } = {}) {
  return createIpcArgsSchema<[string]>((channel, args) => {
    if (args.length !== 1 || typeof args[0] !== 'string') {
      throw new Error(`${channel} requires ${label} to be a string.`)
    }
    return [normalizeStringArg(channel, label, args[0], options.maxBytes)]
  })
}

export function optionalStringArg(label: string, options: { maxBytes?: number } = {}) {
  return createIpcArgsSchema<[string | null | undefined]>((channel, args) => {
    if (args.length > 1) {
      throw new Error(`${channel} accepts at most one argument.`)
    }
    const value = args[0]
    if (value === undefined || value === null) return [value]
    if (typeof value !== 'string') {
      throw new Error(`${channel} requires ${label} to be a string when provided.`)
    }
    return [normalizeStringArg(channel, label, value, options.maxBytes)]
  })
}

export function objectArg<T extends object>(label: string) {
  return createIpcArgsSchema<[T]>((channel, args) => {
    if (args.length !== 1) {
      throw new Error(`${channel} requires exactly one ${label} argument.`)
    }
    return [normalizeObjectArg<T>(channel, label, args[0])]
  })
}

export function optionalObjectArg<T extends object>(label: string) {
  return createIpcArgsSchema<[T | undefined]>((channel, args) => {
    if (args.length > 1) {
      throw new Error(`${channel} accepts at most one argument.`)
    }
    if (args[0] === undefined || args[0] === null) return [undefined]
    return [normalizeObjectArg<T>(channel, label, args[0])]
  })
}

export function stringAndObjectArgs<T extends object>(
  stringLabel: string,
  objectLabel: string,
  options: { maxBytes?: number } = {},
) {
  return createIpcArgsSchema<[string, T]>((channel, args) => {
    if (args.length !== 2) {
      throw new Error(`${channel} requires ${stringLabel} and ${objectLabel}.`)
    }
    if (typeof args[0] !== 'string') {
      throw new Error(`${channel} requires ${stringLabel} to be a string.`)
    }
    return [
      normalizeStringArg(channel, stringLabel, args[0], options.maxBytes),
      normalizeObjectArg<T>(channel, objectLabel, args[1]),
    ]
  })
}

export function objectAndOptionalStringArgs<T extends object>(
  objectLabel: string,
  optionalStringLabel: string,
) {
  return createIpcArgsSchema<[T, string | null | undefined]>((channel, args) => {
    if (args.length < 1 || args.length > 2) {
      throw new Error(`${channel} requires ${objectLabel}.`)
    }
    const token = args[1]
    if (token !== undefined && token !== null && typeof token !== 'string') {
      throw new Error(`${channel} requires ${optionalStringLabel} to be a string when provided.`)
    }
    return [
      normalizeObjectArg<T>(channel, objectLabel, args[0]),
      token,
    ]
  })
}

export function sessionPromptArgs() {
  return createIpcArgsSchema<[string, unknown, unknown | undefined, unknown | undefined, unknown | undefined]>((channel, args) => {
    if (args.length < 2 || args.length > 5) {
      throw new Error(`${channel} requires session id and prompt text.`)
    }
    if (typeof args[0] !== 'string') {
      throw new Error(`${channel} requires session id to be a string.`)
    }
    return [
      normalizeStringArg(channel, 'session id', args[0], 512),
      args[1],
      args[2],
      args[3],
      args[4],
    ]
  })
}

function normalizeStringArg(channel: string, label: string, value: string, maxBytes = 4096) {
  const trimmed = value.trim()
  if (!trimmed) {
    throw new Error(`${channel} requires ${label}.`)
  }
  if (new TextEncoder().encode(trimmed).length > maxBytes) {
    throw new Error(`${channel} ${label} is too large.`)
  }
  return trimmed
}

function normalizeObjectArg<T extends object>(channel: string, label: string, value: unknown): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${channel} requires ${label} to be an object.`)
  }
  return value as T
}
