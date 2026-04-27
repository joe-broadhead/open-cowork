export type RuntimeReconnectState = {
  appCleanupStarted: boolean
  appIsQuitting: boolean
  reconnectTimerActive: boolean
}

export function shouldScheduleRuntimeReconnect(state: RuntimeReconnectState) {
  return !state.appCleanupStarted && !state.appIsQuitting && !state.reconnectTimerActive
}
