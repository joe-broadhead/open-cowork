function isOpaqueFileOrigin(origin: string) {
  return origin === 'null' || origin === 'file://'
}

function originMatches(eventOrigin: string, expectedOrigin: string) {
  if (eventOrigin === expectedOrigin) return true
  return isOpaqueFileOrigin(eventOrigin) && isOpaqueFileOrigin(expectedOrigin)
}

export function shouldHandleChartFrameMessage(options: {
  frameWindow: Window | null
  eventSource: MessageEventSource | null
  eventOrigin: string
  expectedOrigin: string
}) {
  return Boolean(
    options.frameWindow
    && options.eventSource === options.frameWindow
    && originMatches(options.eventOrigin, options.expectedOrigin),
  )
}
