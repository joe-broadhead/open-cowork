import { t } from '../../helpers/i18n'
import { ReviewPanel, TaskLane } from '../ui'

interface Props {
  pendingApprovals: number
  pendingQuestions: number
  taskCount: number
}

export function HomeReviewSnapshot({ pendingApprovals, pendingQuestions, taskCount }: Props) {
  const totalInput = pendingApprovals + pendingQuestions

  return (
    <div className="w-full mt-8">
      <ReviewPanel
        title={t('home.review.title', 'Review Snapshot')}
        summary={t('home.review.summary', 'Live review state from the active OpenCode session projection.')}
        status={{ label: totalInput > 0 ? t('home.review.needsInput', 'Needs input') : t('home.review.clear', 'Clear'), tone: totalInput > 0 ? 'warning' : 'success' }}
      >
        <div className="grid gap-3 md:grid-cols-2">
          <TaskLane
            title={t('home.review.decisions', 'Decisions')}
            tone="approval"
            items={[
              ...(pendingApprovals > 0 ? [{
                id: 'approvals',
                title: t('home.review.approvals', 'Permission approvals'),
                meta: t('home.review.pendingCount', '{{count}} pending', { count: pendingApprovals }),
                status: { label: t('home.review.open', 'Open'), tone: 'warning' as const },
              }] : []),
              ...(pendingQuestions > 0 ? [{
                id: 'questions',
                title: t('home.review.questions', 'Questions'),
                meta: t('home.review.pendingCount', '{{count}} pending', { count: pendingQuestions }),
                status: { label: t('home.review.open', 'Open'), tone: 'warning' as const },
              }] : []),
            ]}
            emptyLabel={t('home.review.noDecisions', 'No decisions waiting')}
          />
          <TaskLane
            title={t('home.review.coworkers', 'Coworker Activity')}
            tone="delegated"
            items={taskCount > 0 ? [{
              id: 'task-runs',
              title: t('home.review.specialistLanes', 'Specialist lanes'),
              meta: t('home.review.taskCount', '{{count}} task runs', { count: taskCount }),
              status: { label: t('home.review.projected', 'Projected'), tone: 'accent' },
            }] : []}
            emptyLabel={t('home.review.noCoworkers', 'No delegated runs active')}
          />
        </div>
      </ReviewPanel>
    </div>
  )
}
