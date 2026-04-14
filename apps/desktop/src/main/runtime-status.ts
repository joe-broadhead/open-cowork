let runtimeReady = false
let runtimeError: string | null = null

export function setRuntimeReady(value: boolean, error?: string | null) {
  runtimeReady = value
  if (error !== undefined) {
    runtimeError = error
  } else if (value) {
    runtimeError = null
  }
}

export function isRuntimeReady() {
  return runtimeReady
}

export function setRuntimeError(error: string | null) {
  runtimeError = error
  if (error) {
    runtimeReady = false
  }
}

export function getRuntimeStatus() {
  return {
    ready: runtimeReady,
    error: runtimeError,
  }
}
