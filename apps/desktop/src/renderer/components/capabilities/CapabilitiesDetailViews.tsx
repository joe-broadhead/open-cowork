import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type {
  CapabilitySkill,
  CapabilitySkillBundle,
  CapabilityTool,
  CustomMcpConfig,
  CustomSkillConfig,
  RuntimeContextOptions,
} from '@open-cowork/shared'
import { getBrandName } from '../../helpers/brand'
import { t } from '../../helpers/i18n'
import {
  type CapabilityLinkedTool,
  prettyKind,
  prettySkillKind,
  prettySkillSource,
  stripFrontmatter,
} from './capabilities-page-support.ts'
import {
  SkillBundleFileEntry,
  StatBox,
  ToolCredentialsCard,
  ToolIntegrationToggleCard,
} from './capabilities-page-components.tsx'
import { Badge, Button } from '../ui'

type AvailableToolMethod = { id: string; description: string }

function CapabilitiesBackButton({ onBack }: { onBack: () => void }) {
  return (
    <Button onClick={onBack} variant="ghost" size="sm" leftIcon="chevron-left" className="mb-6">
      Tools & Skills
    </Button>
  )
}

export function CapabilityToolDetailView({
  selectedTool,
  custom,
  availableTools,
  linkedSkills,
  onBack,
  onCreateAgent,
  onEditTool,
  onRemoveTool,
  onOpenSkill,
}: {
  selectedTool: CapabilityTool
  custom: CustomMcpConfig | null
  availableTools: readonly AvailableToolMethod[]
  linkedSkills: readonly CapabilitySkill[]
  onBack: () => void
  onCreateAgent: () => void
  onEditTool: () => void
  onRemoveTool: () => Promise<void>
  onOpenSkill: (skillName: string) => void
}) {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="feature-page-shell">
        <CapabilitiesBackButton onBack={onBack} />

        <div className="rounded-2xl border border-border-subtle bg-surface p-5 mb-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 mb-2">
                <Badge tone="accent">
                  {prettyKind(selectedTool)}
                </Badge>
                <Badge tone={selectedTool.source === 'custom' ? 'warning' : 'success'}>
                  {selectedTool.source === 'custom' ? 'Installed' : 'Built-in'}
                </Badge>
              </div>
              <h1 className="text-[20px] font-semibold text-text mb-1">{selectedTool.name}</h1>
              <p className="text-[13px] text-text-secondary leading-relaxed">{selectedTool.description}</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Button
                onClick={onCreateAgent}
                variant="secondary"
                size="sm"
              >
                Create coworker
              </Button>
              {custom ? (
                <>
                  <Button
                    onClick={onEditTool}
                    variant="secondary"
                    size="sm"
                  >
                    Edit tool
                  </Button>
                  <Button
                    onClick={() => void onRemoveTool()}
                    variant="danger"
                    size="sm"
                  >
                    Remove tool
                  </Button>
                </>
              ) : null}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_320px] gap-5">
          <div className="flex flex-col gap-5">
            <div className="rounded-xl border border-border-subtle bg-surface p-4">
              <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted mb-3">{t('capabilities.details', 'Details')}</div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <StatBox label="Identifier" value={selectedTool.id} />
                <StatBox
                  label="Source"
                  value={selectedTool.origin === 'opencode'
                    ? 'OpenCode runtime'
                    : selectedTool.source === 'custom'
                      ? (custom?.label?.trim() || custom?.name || 'Custom MCP')
                      : `${getBrandName()} config`}
                />
                <StatBox label="Runtime namespace" value={selectedTool.namespace || selectedTool.id} />
                <StatBox label="Used by coworkers" value={selectedTool.agentNames.length > 0 ? selectedTool.agentNames.join(', ') : 'No coworkers yet'} />
              </div>
            </div>

            <div className="rounded-xl border border-border-subtle bg-surface p-4">
              <div className="flex items-center justify-between gap-3 mb-3">
                <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted">
                  {selectedTool.origin === 'opencode' ? 'Runtime metadata' : 'Available methods'}
                </div>
                <span className="text-[10px] text-text-muted">
                  {selectedTool.origin === 'opencode' ? `${availableTools.length} entries` : `${availableTools.length} methods`}
                </span>
              </div>
              {availableTools.length > 0 ? (
                <div className="flex flex-col gap-2">
                  {availableTools.map((entry) => (
                    <div key={entry.id} className="rounded-xl border border-border-subtle bg-elevated px-3 py-3">
                      <div className="text-[12px] font-medium text-text">{entry.id}</div>
                      <div className="text-[11px] text-text-muted mt-1 leading-relaxed">{entry.description}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-[12px] text-text-muted">
                  {selectedTool.origin === 'opencode'
                    ? 'No runtime metadata is available for this tool yet.'
                    : 'No MCP methods have been discovered for this tool yet.'}
                </div>
              )}
            </div>

            {custom ? (
              <div className="rounded-xl border border-border-subtle bg-surface p-4">
                <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted mb-3">{t('capabilities.connection', 'Connection')}</div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <StatBox label="Type" value={custom.type === 'stdio' ? 'Local stdio MCP' : 'Remote HTTP / SSE MCP'} />
                  {custom.type === 'stdio' ? (
                    <StatBox label="Command" value={custom.command || 'Not set'} />
                  ) : (
                    <StatBox label="Endpoint" value={custom.url || 'Not set'} />
                  )}
                </div>
              </div>
            ) : null}

            {selectedTool.integrationId && selectedTool.authMode ? (
              <ToolIntegrationToggleCard
                integrationId={selectedTool.integrationId}
                authMode={selectedTool.authMode}
                enabled={selectedTool.enabled}
              />
            ) : null}

            {selectedTool.credentials && selectedTool.credentials.length > 0 && selectedTool.integrationId ? (
              <ToolCredentialsCard
                integrationId={selectedTool.integrationId}
                credentials={selectedTool.credentials}
                authMode={selectedTool.authMode}
              />
            ) : null}
          </div>

          <div className="flex flex-col gap-5">
            <div className="rounded-xl border border-border-subtle bg-surface p-4">
              <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted mb-3">{t('capabilities.linkedSkills', 'Linked skills')}</div>
              {linkedSkills.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {linkedSkills.map((skill) => (
                    <Button
                      key={skill.name}
                      type="button"
                      onClick={() => onOpenSkill(skill.name)}
                      variant="secondary"
                      size="sm"
                    >
                      {skill.label}
                    </Button>
                  ))}
                </div>
              ) : (
                <div className="text-[12px] text-text-muted">No skills are linked to this tool yet.</div>
              )}
            </div>

            <div className="rounded-xl border border-border-subtle bg-surface p-4">
              <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted mb-3">{t('capabilities.linkedCoworkers', 'Linked coworkers')}</div>
              {selectedTool.agentNames.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {selectedTool.agentNames.map((agentName) => (
                    <span key={agentName} className="px-2 py-1 rounded-md border border-border-subtle text-[10px] text-text-secondary">
                      {agentName}
                    </span>
                  ))}
                </div>
              ) : (
                <div className="text-[12px] text-text-muted">No built-in or custom coworkers use this tool yet.</div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export function CapabilitySkillDetailView({
  selectedSkill,
  custom,
  bundle,
  linkedTools,
  contextOptions,
  onBack,
  onCreateAgent,
  onEditSkill,
  onRemoveSkill,
  onOpenTool,
}: {
  selectedSkill: CapabilitySkill
  custom: CustomSkillConfig | null
  bundle: CapabilitySkillBundle | null
  linkedTools: readonly CapabilityLinkedTool[]
  contextOptions: RuntimeContextOptions | undefined
  onBack: () => void
  onCreateAgent: () => void
  onEditSkill: () => void
  onRemoveSkill: () => Promise<void>
  onOpenTool: (toolId: string) => void
}) {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="feature-page-shell">
        <CapabilitiesBackButton onBack={onBack} />

        <div className="rounded-2xl border border-border-subtle bg-surface p-5 mb-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 mb-2">
                <Badge tone={selectedSkill.source === 'custom' ? 'warning' : 'accent'}>
                  {prettySkillKind(selectedSkill)}
                </Badge>
              </div>
              <h1 className="text-[20px] font-semibold text-text mb-1">{selectedSkill.label}</h1>
              <p className="text-[13px] text-text-secondary leading-relaxed">{selectedSkill.description}</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Button
                onClick={onCreateAgent}
                variant="secondary"
                size="sm"
              >
                Create coworker
              </Button>
              {custom ? (
                <>
                  <Button
                    onClick={onEditSkill}
                    variant="secondary"
                    size="sm"
                  >
                    Edit skill
                  </Button>
                  <Button
                    onClick={() => void onRemoveSkill()}
                    variant="danger"
                    size="sm"
                  >
                    Remove skill
                  </Button>
                </>
              ) : null}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_320px] gap-5 min-w-0">
          <div className="rounded-xl border border-border-subtle bg-surface p-4 min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted mb-3">{t('capabilities.skillContent', 'Skill Content')}</div>
            {bundle?.content ? (
              <div className="min-w-0 max-w-full overflow-x-auto">
                <div className="prose prose-invert max-w-none text-[12px] text-text-secondary leading-relaxed [&_table]:block [&_table]:overflow-x-auto [&_table]:max-w-full [&_pre]:overflow-x-auto [&_pre]:whitespace-pre [&_code]:break-words [&_p]:break-words">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {stripFrontmatter(bundle.content)}
                  </ReactMarkdown>
                </div>
              </div>
            ) : (
              <div className="text-[12px] text-text-muted">{t('capabilities.noSkillContent', 'No skill bundle content is available yet.')}</div>
            )}
          </div>

          <div className="flex flex-col gap-5">
            <div className="rounded-xl border border-border-subtle bg-surface p-4">
              <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted mb-3">{t('capabilities.details', 'Details')}</div>
              <div className="flex flex-col gap-3">
                <StatBox label="Identifier" value={selectedSkill.name} />
                <StatBox label="Source" value={prettySkillSource(selectedSkill)} />
                {selectedSkill.location ? (
                  <StatBox label="Location" value={selectedSkill.location} />
                ) : null}
              </div>
            </div>

            <div className="rounded-xl border border-border-subtle bg-surface p-4">
              <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted mb-3">{t('capabilities.linkedTools', 'Linked tools')}</div>
              {linkedTools.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {linkedTools.map((tool) => (
                    <Button
                      key={tool.id}
                      type="button"
                      onClick={() => onOpenTool(tool.id)}
                      variant="secondary"
                      size="sm"
                    >
                      {tool.name}
                    </Button>
                  ))}
                </div>
              ) : (
                <div className="text-[12px] text-text-muted">{t('capabilities.skillNotTiedToTool', 'This skill is not tied to a specific tool.')}</div>
              )}
            </div>

            <div className="rounded-xl border border-border-subtle bg-surface p-4">
              <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted mb-3">{t('capabilities.usedByCoworkers', 'Used by coworkers')}</div>
              {selectedSkill.agentNames.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {selectedSkill.agentNames.map((agentName) => (
                    <span key={agentName} className="px-2 py-1 rounded-md border border-border-subtle text-[10px] text-text-secondary">
                      {agentName}
                    </span>
                  ))}
                </div>
              ) : (
                <div className="text-[12px] text-text-muted">No built-in or custom coworkers use this skill yet.</div>
              )}
            </div>

            {bundle?.files.length ? (
              <div className="rounded-xl border border-border-subtle bg-surface p-4">
                <div className="flex items-center justify-between gap-3 mb-3">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted">{t('capabilities.bundleFiles', 'Bundle files')}</div>
                  <span className="text-[10px] text-text-muted">{bundle.files.length} files</span>
                </div>
                <div className="flex flex-col gap-2">
                  {bundle.files.map((file) => (
                    <SkillBundleFileEntry
                      key={file.path}
                      skillName={selectedSkill.name}
                      filePath={file.path}
                      context={contextOptions}
                    />
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}
