export type TaskDrillInWidthMode = 'custom' | 'thread'

export const DEFAULT_TASK_DRILL_IN_WIDTH = 460
export const MIN_TASK_DRILL_IN_WIDTH = 420
export const MAX_TASK_DRILL_IN_WIDTH_VIEWPORT_RATIO = 0.92

function getMaxWidth(viewportWidth: number) {
  return Math.max(320, Math.floor(viewportWidth * MAX_TASK_DRILL_IN_WIDTH_VIEWPORT_RATIO))
}

export function clampTaskDrillInWidth(width: number, viewportWidth: number) {
  const maxWidth = getMaxWidth(viewportWidth)
  const minWidth = Math.min(MIN_TASK_DRILL_IN_WIDTH, maxWidth)
  return Math.min(Math.max(width, minWidth), maxWidth)
}

export function resolveTaskDrillInWidth(options: {
  mode: TaskDrillInWidthMode
  customWidth: number
  threadWidth: number
  viewportWidth: number
}) {
  const targetWidth = options.mode === 'thread' ? options.threadWidth : options.customWidth
  return clampTaskDrillInWidth(targetWidth, options.viewportWidth)
}
