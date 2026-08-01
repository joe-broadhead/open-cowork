export type DesktopRuntimeStartIntent = 'validated' | 'setup_connection_validation'

export function canStartDesktopRuntime(
  setupComplete: boolean,
  intent: DesktopRuntimeStartIntent,
) {
  return setupComplete || intent === 'setup_connection_validation'
}
