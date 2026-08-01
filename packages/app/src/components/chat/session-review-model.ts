import type { SessionArtifact, SessionView } from '@open-cowork/shared'

export type SessionReviewSummary = {
  decisionCount: number
  artifactCount: number
  activeTaskCount: number
  deliverableCount: number
  totalCount: number
}

/**
 * The user-facing Review projection. Keep this calculation independent from
 * panel state so streamed session events can update the badge without opening
 * or remounting the inspector.
 */
export function sessionReviewSummary(
  view: SessionView,
  artifacts: SessionArtifact[],
): SessionReviewSummary {
  const decisionCount = view.pendingApprovals.length + view.pendingQuestions.length
  const artifactCount = artifacts.length
  const activeTaskCount = view.taskRuns.filter(
    (task) => task.status === 'running' || task.status === 'queued',
  ).length
  const deliverableCount = artifactCount

  return {
    decisionCount,
    artifactCount,
    activeTaskCount,
    deliverableCount,
    totalCount: decisionCount + deliverableCount,
  }
}
