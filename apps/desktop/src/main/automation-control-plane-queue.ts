import type { SerialRunner } from './promise-chain.ts'

export type CoalescedControlPlaneTask = {
  run(task: () => Promise<void>): Promise<boolean>
  isPending(): boolean
}

export function createCoalescedControlPlaneTask(runSerially: SerialRunner): CoalescedControlPlaneTask {
  let pending = false

  return {
    isPending() {
      return pending
    },
    async run(task: () => Promise<void>) {
      if (pending) return false
      pending = true
      try {
        await runSerially(task)
        return true
      } finally {
        pending = false
      }
    },
  }
}
