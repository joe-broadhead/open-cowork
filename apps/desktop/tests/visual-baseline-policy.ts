import { readFileSync } from 'node:fs'

export const VISUAL_BASELINE_UPDATE_COMMAND =
  'OPEN_COWORK_EVAL_UPDATE_BASELINES=1 pnpm test:e2e:evals'

export function shouldUpdateVisualBaselines(value = process.env.OPEN_COWORK_EVAL_UPDATE_BASELINES): boolean {
  const normalized = value?.trim().toLowerCase()
  return normalized === '1' || normalized === 'true'
}

export function readCommittedVisualBaseline(path: string): Buffer {
  try {
    return readFileSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    throw new Error(
      `Missing committed visual baseline: ${path}. Normal eval runs do not create baselines. `
      + `Review and update them explicitly with: ${VISUAL_BASELINE_UPDATE_COMMAND}`,
      { cause: error },
    )
  }
}
