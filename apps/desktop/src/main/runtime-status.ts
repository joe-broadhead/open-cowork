let runtimeReady = false

export function setRuntimeReady(value: boolean) {
  runtimeReady = value
}

export function isRuntimeReady() {
  return runtimeReady
}
