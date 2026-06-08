import { useState, type ReactNode } from 'react'
import { Badge } from './Badge.js'
import { Button, IconButton, type ButtonSize, type ButtonVariant } from './Button.js'
import { Card } from './Card.js'
import { Dialog } from './Dialog.js'
import { EmptyState } from './EmptyState.js'
import { Icon } from './Icon.js'
import { Input, Textarea } from './Input.js'
import { Kbd } from './Kbd.js'
import { Menu, Select } from './Select.js'
import { SegmentedControl } from './SegmentedControl.js'
import { Skeleton } from './Skeleton.js'
import {
  ApprovalCard,
  ArtifactCard,
  ChannelRow,
  ChannelStatusCard,
  ComposerShell,
  ConversationLaneCard,
  CoworkerCard,
  DeliverableCard,
  KanbanBoard,
  PermissionEditorRow,
  PersonRow,
  ProjectCard,
  ReviewPanel,
  RunTimeline,
  StudioPageHeader,
  StudioShell,
  TaskLane,
  TraitSlider,
  WikiPage,
  WikiSpaceRail,
  WizardStepPane,
  WizardSteps,
  WorkingStyleBars,
} from './StudioPrimitives.js'
import { Tooltip } from './Tooltip.js'
import { toast } from './Toaster.js'

const buttonVariants: ButtonVariant[] = ['primary', 'secondary', 'ghost', 'danger']
const buttonSizes: ButtonSize[] = ['sm', 'md', 'lg']
const iconVariants = ['secondary', 'ghost', 'danger'] as const
const iconSizes = ['sm', 'md'] as const
const tones = ['neutral', 'accent', 'success', 'warning', 'danger'] as const

function GallerySection({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <section className="space-y-3">
      <h2 className="font-display text-role-section-title font-bold text-text">{title}</h2>
      <Card padding="lg" className="space-y-4">
        {children}
      </Card>
    </section>
  )
}

export function PrimitiveGallery() {
  const [selectValue, setSelectValue] = useState('build')
  const [segment, setSegment] = useState('plan')
  const [dialogSize, setDialogSize] = useState<'sm' | 'md' | 'lg' | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [menuAction, setMenuAction] = useState('No action yet')
  const [cardAction, setCardAction] = useState('No card action yet')
  const [permissionPolicy, setPermissionPolicy] = useState<'allow' | 'ask' | 'deny'>('ask')
  const [wizardStep, setWizardStep] = useState('profile')
  const [traitValue, setTraitValue] = useState(68)

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-base">
      <div className="ui-primitive-gallery__shell mx-auto flex w-full flex-col gap-8 px-8 py-8">
        <header className="space-y-2">
          <Badge tone="accent">Design system QA</Badge>
          <h1 className="font-display text-role-page-title font-bold text-text">UI primitives</h1>
        </header>

        <GallerySection title="Buttons">
          <div className="grid gap-4">
            {buttonVariants.map((variant) => (
              <div key={variant} className="flex flex-wrap items-center gap-3">
                {buttonSizes.map((size) => (
                  <Button key={`${variant}-${size}`} variant={variant} size={size} leftIcon="sparkles">
                    {variant} {size}
                  </Button>
                ))}
                <Button variant={variant} loading>Loading</Button>
                <Button variant={variant} disabledReason="Workspace policy disables this action.">Disabled</Button>
              </div>
            ))}
          </div>
        </GallerySection>

        <GallerySection title="Studio Shell And Coworking Primitives">
          <StudioShell
            brand={{ name: 'Open Cowork', subtitle: 'Studio preview' }}
            activeItemId="home"
            navSections={[
              {
                id: 'primary',
                label: 'Work',
                items: [
                  { id: 'home', label: 'Home', icon: 'home', badge: '3' },
                  { id: 'projects', label: 'Projects', icon: 'folder' },
                  { id: 'approvals', label: 'Approvals', icon: 'badge-check' },
                ],
              },
              {
                id: 'manage',
                label: 'Manage',
                items: [
                  { id: 'team', label: 'Team', icon: 'users' },
                  { id: 'playbooks', label: 'Playbooks', icon: 'workflow' },
                  { id: 'tools', label: 'Tools & Skills', icon: 'wrench' },
                ],
              },
            ]}
            header={(
              <StudioPageHeader
                eyebrow="Studio"
                title="What shall we cowork on today?"
                description="Choose a lead coworker, add context, and keep OpenCode execution visible."
                actions={[{ id: 'new', variant: 'primary', leftIcon: 'plus', children: 'New chat' }]}
              />
            )}
          >
            <div className="studio-preview-grid">
              <CoworkerCard
                name="Jordan"
                role="Lead coworker"
                tone="lead"
                presence={{ status: 'working', label: 'Running session' }}
                mode="Planning"
                summary="Coordinates the session while OpenCode owns execution, tool calls, and approvals."
                status={{ label: 'Ready', tone: 'success' }}
                abilities={['OpenCode', 'Review', 'Artifacts']}
                styleBars={[
                  { id: 'speed', label: 'Speed', value: 72 },
                  { id: 'depth', label: 'Depth', value: 58 },
                ]}
              />
              <ComposerShell
                label="Message the studio"
                placeholder="Ask the team to build, review, or research..."
                assignMenu={<Button variant="secondary" size="sm" leftIcon="users">Assign</Button>}
                helper="OpenCode remains the runtime source of truth."
                actions={[{ id: 'send', type: 'submit', variant: 'primary', rightIcon: 'arrow-up', children: 'Send' }]}
                onSubmit={(event) => event.preventDefault()}
              />
              <TaskLane
                title="Delegation lane"
                tone="delegated"
                description="Specialists stay visibly connected to the lead session."
                items={[
                  { id: 'api', title: 'API review', meta: 'Specialist', status: { label: 'Running', tone: 'accent' } },
                  { id: 'tests', title: 'Coverage pass', meta: 'Reviewer', status: { label: 'Waiting', tone: 'warning' } },
                ]}
              />
              <ReviewPanel
                title="Review queue"
                summary="Production checks before handoff."
                status={{ label: '2 findings', tone: 'warning' }}
                actions={[{ id: 'open', children: 'Open review' }]}
              >
                <ApprovalCard
                  title="Approve shell command"
                  requester="OpenCode permission"
                  body="The UI presents the wait state; OpenCode owns the approval contract."
                  actions={[
                    { id: 'deny', variant: 'secondary', children: 'Deny' },
                    { id: 'allow', variant: 'primary', children: 'Allow' },
                  ]}
                />
              </ReviewPanel>
              <ProjectCard
                title="Studio parity"
                description="Desktop and Cloud share the same IA and visual vocabulary."
                status={{ label: 'Active', tone: 'success' }}
                meta="3 sessions"
                progress={72}
                progressLabel="72% ready"
              />
              <ArtifactCard
                title="Roadmap brief"
                description="Generated deliverable attached to the session."
                status={{ label: 'Draft', tone: 'neutral' }}
              />
              <ChannelStatusCard
                title="Cloud gateway"
                description="External channels route into Open Cowork without becoming a second runtime."
                status={{ label: 'Healthy', tone: 'success' }}
              />
            </div>
          </StudioShell>
        </GallerySection>

        <GallerySection title="Studio Production Primitives">
          <div className="studio-preview-grid studio-preview-grid--wide">
            <ConversationLaneCard
              title="Security review"
              coworker={{ name: 'Maya', role: 'Reviewer', tone: 'reviewer' }}
              task="Inspect auth edge cases"
              status="live"
              runtimeLabel="OpenCode"
              activities={[
                { id: 'read', verb: 'Reading', object: 'runtime policy', icon: 'book-open', time: 'now' },
                { id: 'done', verb: 'Checked', object: 'approval handoff', icon: 'shield-check', time: '1m', done: true },
              ]}
              handoff="Ready for lead review"
            />
            <ConversationLaneCard
              title="No delegated work"
              coworker={{ name: 'Kai', role: 'Builder', tone: 'builder' }}
              status="waiting"
              activities={[]}
            />
            <KanbanBoard
              columns={[
                {
                  id: 'todo',
                  title: 'Queued',
                  tasks: [
                    {
                      id: 'api',
                      title: 'Wire channel route',
                      priority: 'high',
                      assignee: { name: 'Maya', tone: 'reviewer', presence: 'working' },
                      run: { label: 'running', live: true },
                    },
                  ],
                },
                { id: 'review', title: 'Review', over: true, tasks: [] },
              ]}
            />
            <RunTimeline
              stateLabel="Running"
              live
              sessionId="ses_9f2a"
              currentStepId="running"
              completedStepIds={['queued']}
              steps={[
                { id: 'queued', label: 'Queued' },
                { id: 'running', label: 'Running' },
                { id: 'review', label: 'Review' },
                { id: 'done', label: 'Done' },
              ]}
            />
            <PermissionEditorRow
              toolName="Bash"
              description="Per-tool policy with scoped glob rules."
              policy={permissionPolicy}
              onPolicyChange={setPermissionPolicy}
              rules={['scripts/**/*.mjs', 'apps/**/src/**']}
            />
            <DeliverableCard
              title="Test evidence bundle"
              meta="Markdown + captured trace"
              icon="file-text"
              preview={<span>## Release evidence</span>}
              actions={[{ id: 'open', children: 'Open' }]}
              captureAction={{ id: 'capture', leftIcon: 'camera', children: 'Capture preview' }}
              capturedLabel="Captured 2 minutes ago"
            />
            <ChannelRow
              title="Slack"
              description="Gateway messages are projected into the active OpenCode-backed session."
              status={{ label: 'Healthy', tone: 'success' }}
              meta={<span>3 channels</span>}
            />
            <PersonRow
              name="Alex Morgan"
              detail={<span><Icon name="at-sign" size={16} /> alex@example.com</span>}
              tone="operator"
              presence="available"
              role={{ label: 'Owner', tone: 'accent', description: 'Can approve tool policy' }}
            />
            <div className="studio-mini-panel">
              <WizardSteps
                activeStepId={wizardStep}
                onSelect={(step) => setWizardStep(step.id)}
                steps={[
                  { id: 'profile', label: 'Profile', icon: 'user-round-check', completed: wizardStep !== 'profile' },
                  { id: 'tools', label: 'Tools', icon: 'wrench' },
                  { id: 'review', label: 'Review', icon: 'badge-check' },
                ]}
              />
              <WizardStepPane title="Working style" hint="Tune how the coworker plans before OpenCode execution starts.">
                <TraitSlider label="Autonomy" icon="sliders" value={traitValue} minLabel="Guided" maxLabel="Independent" onValueChange={setTraitValue} />
                <WorkingStyleBars
                  bars={[
                    { id: 'creative', label: 'Creative', value: 62 },
                    { id: 'precise', label: 'Precise', value: 84 },
                  ]}
                />
              </WizardStepPane>
            </div>
            <div className="studio-wiki-demo">
              <WikiSpaceRail
                activePageId="runtime"
                reviewAction={<Button size="sm" variant="secondary" leftIcon="badge-check">Review queue</Button>}
                spaces={[
                  { id: 'studio', name: 'Studio', icon: 'book-open', pages: [{ id: 'runtime', title: 'Runtime boundary' }, { id: 'ui', title: 'UI language' }] },
                ]}
              />
              <WikiPage
                breadcrumbs={['Studio', 'Runtime boundary']}
                title="OpenCode owns execution"
                meta={<Badge tone="accent">Knowledge</Badge>}
                blocks={[
                  { id: 'h', type: 'heading', text: 'Composition rule' },
                  { id: 'p', type: 'paragraph', text: 'Open Cowork presents collaboration state while OpenCode remains the execution source.' },
                  { id: 'c', type: 'callout', icon: 'shield-check', text: 'Do not duplicate runtime approval behavior in product UI.' },
                  { id: 'l', type: 'list', items: ['Sessions', 'Permissions', 'Streaming events'] },
                ]}
                links={[{ id: 'arch', label: 'Architecture', icon: 'network' }]}
              />
            </div>
          </div>
        </GallerySection>

        <GallerySection title="Icon Buttons">
          <div className="flex flex-wrap items-start gap-4">
            {iconVariants.map((variant) => (
              <div key={variant} className="flex items-center gap-2">
                {iconSizes.map((size) => (
                  <IconButton key={`${variant}-${size}`} icon="search" label={`${variant} ${size} search`} variant={variant} size={size} />
                ))}
                <IconButton icon="bell" label="Unread notices" variant={variant} badge="3" />
              </div>
            ))}
            <IconButton icon="loader-circle" label="Loading settings" loading />
            <IconButton icon="settings-2" label="Disabled settings" disabledReason="Settings are managed by this workspace." />
          </div>
        </GallerySection>

        <GallerySection title="Fields">
          <div className="grid gap-4 md:grid-cols-3">
            <Input aria-label="Small input" size="sm" leftIcon="search" placeholder="Small input" clearable defaultValue="Query" />
            <Input aria-label="Medium input" size="md" placeholder="Medium input" error="Use a shorter name." />
            <Input aria-label="Large input" size="lg" placeholder="Large input" disabledReason="This value is locked." />
          </div>
          <Textarea aria-label="Notes" autoGrow maxHeight="md" placeholder="Notes" defaultValue="Review notes" />
        </GallerySection>

        <GallerySection title="Select And Menu">
          <div className="grid gap-4 md:grid-cols-3">
            <Select
              label="Mode"
              value={selectValue}
              onChange={setSelectValue}
              options={[
                { value: 'plan', label: 'Plan' },
                { value: 'build', label: 'Build' },
                { value: 'review', label: 'Review', disabled: true, disabledReason: 'Review is not enabled for this workspace.' },
              ]}
            />
            <Menu
              label="Thread actions"
              triggerLabel="Thread actions"
              onSelect={setMenuAction}
              items={[
                { id: 'copy', label: 'Copy link', icon: <Icon name="copy" size={16} /> },
                { id: 'fork', label: 'Fork thread', icon: <Icon name="git-fork" size={16} /> },
                { id: 'delete', label: 'Delete', icon: <Icon name="trash-2" size={16} />, disabled: true, disabledReason: 'Pinned threads cannot be deleted.' },
              ]}
            />
            <div className="text-role-metadata text-text-muted tabular">{menuAction}</div>
          </div>
        </GallerySection>

        <GallerySection title="Dialog">
          <div className="flex flex-wrap gap-3">
            {(['sm', 'md', 'lg'] as const).map((size) => (
              <Button key={size} variant="secondary" onClick={() => setDialogSize(size)}>
                Open {size}
              </Button>
            ))}
            <Button variant="secondary" rightIcon="panel-right-open" onClick={() => setDrawerOpen(true)}>
              Open drawer
            </Button>
          </div>
          {dialogSize ? (
            <Dialog
              title={`${dialogSize.toUpperCase()} dialog`}
              size={dialogSize}
              onClose={() => setDialogSize(null)}
              footer={<Button variant="primary" onClick={() => setDialogSize(null)}>Done</Button>}
            >
              <p className="text-role-body text-text-secondary">Review details</p>
            </Dialog>
          ) : null}
          {drawerOpen ? (
            <Dialog
              title="Task drawer"
              variant="drawer"
              onClose={() => setDrawerOpen(false)}
              footer={<Button variant="primary" onClick={() => setDrawerOpen(false)}>Done</Button>}
            >
              <RunTimeline
                stateLabel="Review"
                currentStepId="review"
                completedStepIds={['queued', 'running']}
                sessionId="ses_drawer"
                steps={[
                  { id: 'queued', label: 'Queued' },
                  { id: 'running', label: 'Running' },
                  { id: 'review', label: 'Review' },
                  { id: 'done', label: 'Done' },
                ]}
              />
            </Dialog>
          ) : null}
        </GallerySection>

        <GallerySection title="Content Primitives">
          <div className="grid gap-4 md:grid-cols-2">
            {(['sm', 'md', 'lg'] as const).map((padding) => (
              <Card key={padding} padding={padding}>
                <div className="ui-card-title font-display text-role-card-title font-bold">Card {padding}</div>
                <p className="mt-2 text-role-body text-text-secondary">Workspace details</p>
              </Card>
            ))}
            <Card interactive padding="lg" onClick={() => setCardAction('Card opened')}>
              <div className="ui-card-title font-display text-role-card-title font-bold">Interactive card</div>
              <p className="mt-2 text-role-body text-text-secondary">Open workspace details</p>
            </Card>
            <Card
              padding="lg"
              variant="tile"
              hover="lift"
              tile={<Icon name="kanban" size={20} />}
              tileLabel="Board"
            >
              <div className="ui-card-title font-display text-role-card-title font-bold">Tile card</div>
              <p className="mt-2 text-role-body text-text-secondary">Hover lift and specular treatment</p>
            </Card>
            <EmptyState
              icon="blocks"
              title="Nothing configured yet"
              body="Create an item to continue."
              action={<Button variant="primary" size="sm">Create item</Button>}
            />
            <div className="text-role-metadata text-text-muted tabular">{cardAction}</div>
          </div>
        </GallerySection>

        <GallerySection title="Badges, Tooltip, Kbd, Skeleton, Toast">
          <div className="flex flex-wrap items-center gap-2">
            {tones.map((tone) => <Badge key={tone} tone={tone}>{tone}</Badge>)}
            <Tooltip content="More detail">
              <span><Button variant="secondary" size="sm">Hover or focus</Button></span>
            </Tooltip>
            <Kbd>Cmd</Kbd>
            <Kbd>K</Kbd>
            <Button
              size="sm"
              onClick={() => toast({ tone: 'success', message: 'Primitive toast preview.' })}
            >
              Toast
            </Button>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <Skeleton variant="text" />
            <Skeleton variant="block" />
            <Skeleton variant="card" />
          </div>
        </GallerySection>

        <GallerySection title="Segmented Control">
          <SegmentedControl
            label="Agent mode"
            value={segment}
            onChange={setSegment}
            options={[
              { value: 'plan', label: 'Plan' },
              { value: 'build', label: 'Build' },
              { value: 'observe', label: 'Observe', disabled: true, disabledReason: 'Observe is not available here.' },
            ]}
          />
          <SegmentedControl
            label="Disabled agent mode"
            value="plan"
            onChange={() => undefined}
            disabledReason="Mode selection is managed by policy."
            options={[
              { value: 'plan', label: 'Plan' },
              { value: 'build', label: 'Build' },
            ]}
          />
        </GallerySection>
      </div>
    </div>
  )
}
