export function shouldHandleChartFrameMessage(options: {
  frameWindow: Window | null
  eventSource: MessageEventSource | null
}) {
  return Boolean(options.frameWindow && options.eventSource === options.frameWindow)
}
