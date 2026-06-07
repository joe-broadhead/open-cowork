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
  ChannelStatusCard,
  ComposerShell,
  CoworkerCard,
  ProjectCard,
  ReviewPanel,
  StudioPageHeader,
  StudioShell,
  TaskLane,
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
  const [menuAction, setMenuAction] = useState('No action yet')
  const [cardAction, setCardAction] = useState('No card action yet')

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
                mode="Planning"
                summary="Coordinates the session while OpenCode owns execution, tool calls, and approvals."
                status={{ label: 'Ready', tone: 'success' }}
                abilities={['OpenCode', 'Review', 'Artifacts']}
              />
              <ComposerShell
                label="Message the studio"
                placeholder="Ask the team to build, review, or research..."
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
