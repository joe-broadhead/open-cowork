import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clampTaskDrillInWidth,
  DEFAULT_TASK_DRILL_IN_WIDTH,
  resolveTaskDrillInWidth,
} from '../apps/desktop/src/renderer/components/chat/task-drill-in-layout.ts'

test('clampTaskDrillInWidth keeps custom widths within the viewport-safe range', () => {
  assert.equal(clampTaskDrillInWidth(200, 1400), 420)
  assert.equal(clampTaskDrillInWidth(DEFAULT_TASK_DRILL_IN_WIDTH, 1400), DEFAULT_TASK_DRILL_IN_WIDTH)
  assert.equal(clampTaskDrillInWidth(1800, 1400), Math.floor(1400 * 0.92))
})

test('clampTaskDrillInWidth relaxes the minimum on narrow viewports', () => {
  assert.equal(clampTaskDrillInWidth(200, 360), Math.floor(360 * 0.92))
})

test('resolveTaskDrillInWidth switches between custom and thread-width modes', () => {
  assert.equal(resolveTaskDrillInWidth({
    mode: 'custom',
    customWidth: 640,
    threadWidth: 900,
    viewportWidth: 1600,
  }), 640)

  assert.equal(resolveTaskDrillInWidth({
    mode: 'thread',
    customWidth: 640,
    threadWidth: 900,
    viewportWidth: 1600,
  }), 900)

  assert.equal(resolveTaskDrillInWidth({
    mode: 'thread',
    customWidth: 640,
    threadWidth: 900,
    viewportWidth: 800,
  }), Math.floor(800 * 0.92))
})
