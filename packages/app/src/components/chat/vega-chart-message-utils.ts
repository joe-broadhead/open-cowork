import { isOpaqueMessageOrigin } from '../../chart-frame-message-origin.ts'

function originMatches(eventOrigin: string, expectedOrigin: string) {
  if (eventOrigin === expectedOrigin) return true
  return isOpaqueMessageOrigin(eventOrigin) && isOpaqueMessageOrigin(expectedOrigin)
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
