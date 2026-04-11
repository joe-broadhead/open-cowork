type AgentPermissionOptions = {
  allToolPatterns: string[]
  allowPatterns?: string[]
  askPatterns?: string[]
  allowBash?: boolean
  askBash?: boolean
  allowEdits?: boolean
  allowWeb?: boolean
  allowQuestion?: boolean
  allowTodoWrite?: boolean
  taskRules?: Record<string, 'allow' | 'ask' | 'deny'>
}

function createPermissionConfig(options: AgentPermissionOptions) {
  const permission: Record<string, unknown> = {
    skill: 'allow',
    question: options.allowQuestion ? 'allow' : 'deny',
    task: options.taskRules ? { '*': 'deny', ...options.taskRules } : 'deny',
    todowrite: options.allowTodoWrite ? 'allow' : 'deny',
    codesearch: options.allowWeb ? 'allow' : 'deny',
    webfetch: options.allowWeb ? 'allow' : 'deny',
    websearch: options.allowWeb ? 'allow' : 'deny',
    bash: options.allowBash ? 'allow' : options.askBash ? 'ask' : 'deny',
    edit: options.allowEdits ? 'allow' : 'deny',
    write: options.allowEdits ? 'allow' : 'deny',
    apply_patch: options.allowEdits ? 'allow' : 'deny',
    read: 'allow',
    grep: 'allow',
    glob: 'allow',
    list: 'allow',
  }

  for (const pattern of options.allToolPatterns) {
    permission[pattern] = 'deny'
  }

  for (const pattern of options.askPatterns || []) {
    permission[pattern] = 'ask'
  }

  for (const pattern of options.allowPatterns || []) {
    permission[pattern] = 'allow'
  }

  return permission
}

function createCoworkPrompt() {
  return [
    'You are Cowork, the primary orchestrator for business work.',
    'Your job is to break work into the smallest reliable mix of direct actions and specialist delegations.',
    '',
    'Operating model:',
    '- Use direct tools only for simple single-surface work.',
    '- Delegate specialist work through the task tool when a dedicated agent or an independent branch would be more reliable.',
    '- Do not use Nova, charts, or Google Workspace MCP tools directly in the parent thread; route that work through the right specialist subagent.',
    '- Keep at most 3 concurrent child tasks.',
    '- Do not create nested subtasks from child agents.',
    '- Never run two writer agents against the same target document, sheet, draft, or file at the same time.',
    '',
    'Delegation rules:',
    '- Use analyst for Nova metrics, SQL, evidence gathering, and chart generation.',
    '- Use explore for read-only codebase and file-system investigation.',
    '- Use sheets-builder for Google Sheets output, formatting, and charts.',
    '- Use docs-writer for Google Docs output.',
    '- Use gmail-drafter for Gmail drafts and email preparation.',
    '- When Atlassian Rovo MCP is enabled, use its bundled Jira and Confluence skills for project tracking, status reporting, and knowledge search.',
    '- When Amplitude MCP is enabled, use its bundled Amplitude skills for product analytics, dashboards, experiments, replays, and instrumentation planning.',
    '- When GitHub MCP is enabled, use it for repositories, issues, pull requests, Actions, and code security workflows.',
    '',
    'Execution rules:',
    '- Give every child task a clear title, expected output, and specialist to use.',
    '- Merge child outputs into a concise parent response with links and artifacts.',
    '- Ask before sending email or creating documents that will be shared externally.',
    '- Present results with evidence, especially for analytics work.',
  ].join('\n')
}

function createPlanPrompt() {
  return [
    'You are Cowork Plan, a read-only planning and audit agent.',
    'Focus on analysis, decomposition, and recommendations.',
    'You may delegate only to read-only or analysis specialists.',
    'Use parallel child tasks only for independent audit branches, with a maximum of 3 concurrent tasks.',
    'Do not modify files, create documents, or send messages.',
    'If an action would produce side effects, stop at a plan or draft recommendation.',
  ].join('\n')
}

function createAnalystPrompt() {
  return [
    'You are Analyst, a specialist subagent for data work.',
    'Load the analyst skill before you begin.',
    'Use Nova to identify metrics, validate lineage, run SQL, and produce evidence-backed findings.',
    'Create chart artifacts when a visualization materially improves the result.',
    'Do not create or share Google Workspace documents directly unless your task explicitly asks for a handoff artifact for another specialist.',
    'Return concise structured findings that the parent can merge into a final response.',
  ].join('\n')
}

function createSheetsBuilderPrompt() {
  return [
    'You are Sheets Builder, a specialist subagent for Google Sheets output.',
    'Load the sheets-reporting skill before you begin.',
    'Build or update spreadsheets, tabs, formatting, and charts.',
    'Prefer clear tab names, readable formatting, and chart outputs that match the provided data.',
    'Return the sheet URL, tabs touched, and chart artifacts or metadata to the parent.',
    'Do not send email or perform unrelated analysis.',
  ].join('\n')
}

function createDocsWriterPrompt() {
  return [
    'You are Docs Writer, a specialist subagent for Google Docs output.',
    'Load the docs-writing skill before you begin.',
    'Create or update documents with clear structure, headings, tables, and references.',
    'Return the document URL and a brief summary of what was written.',
    'Do not send email or perform unrelated analysis.',
  ].join('\n')
}

function createGmailDrafterPrompt() {
  return [
    'You are Gmail Drafter, a specialist subagent for email drafting.',
    'Load the gmail-management skill before you begin.',
    'Prepare draft-ready emails with clear subject lines, concise body copy, and the right links or attachments.',
    'Prefer drafts over sends unless the parent task explicitly requests a send after approval.',
    'Return draft details or the prepared email body to the parent.',
  ].join('\n')
}

export function buildCoworkAgentConfig(options: {
  allToolPatterns: string[]
  allowBash?: boolean
  allowEdits?: boolean
}) {
  const allToolPatterns = options.allToolPatterns

  return {
    cowork: {
      mode: 'primary',
      description: 'Default Cowork orchestrator for business tasks and specialist delegation.',
      color: 'primary',
      prompt: createCoworkPrompt(),
      permission: {
        ...createPermissionConfig({
          allToolPatterns,
          allowPatterns: ['mcp__atlassian-rovo-mcp__*', 'mcp__amplitude__*', 'mcp__github__*'],
          allowQuestion: true,
          allowTodoWrite: true,
          allowBash: options.allowBash,
          allowEdits: options.allowEdits,
          taskRules: {
            analyst: 'allow',
            explore: 'allow',
            'sheets-builder': 'allow',
            'docs-writer': 'allow',
            'gmail-drafter': 'allow',
          },
        }),
      },
    },
    plan: {
      mode: 'primary',
      description: 'Read-only planning and audit agent.',
      color: 'warning',
      prompt: createPlanPrompt(),
      permission: {
        ...createPermissionConfig({
          allToolPatterns,
          allowPatterns: ['mcp__nova__*', 'mcp__charts__*'],
          allowWeb: true,
          askBash: true,
          taskRules: {
            analyst: 'allow',
            explore: 'allow',
          },
        }),
      },
    },
    general: {
      disable: true,
    },
    analyst: {
      mode: 'subagent',
      description: 'Research metrics, SQL, and evidence-backed analysis using Nova.',
      color: 'accent',
      prompt: createAnalystPrompt(),
      permission: {
        ...createPermissionConfig({
          allToolPatterns,
          allowPatterns: ['mcp__nova__*', 'mcp__charts__*'],
        }),
      },
    },
    'sheets-builder': {
      mode: 'subagent',
      hidden: true,
      description: 'Build and format Google Sheets reports and charts.',
      color: 'success',
      prompt: createSheetsBuilderPrompt(),
      permission: {
        ...createPermissionConfig({
          allToolPatterns,
          allowPatterns: ['mcp__google-sheets__*', 'mcp__google-drive__*', 'mcp__charts__*'],
        }),
      },
    },
    'docs-writer': {
      mode: 'subagent',
      hidden: true,
      description: 'Create structured Google Docs outputs.',
      color: 'info',
      prompt: createDocsWriterPrompt(),
      permission: {
        ...createPermissionConfig({
          allToolPatterns,
          allowPatterns: ['mcp__google-docs__*', 'mcp__google-drive__*'],
        }),
      },
    },
    'gmail-drafter': {
      mode: 'subagent',
      hidden: true,
      description: 'Prepare Gmail drafts and outbound communication handoffs.',
      color: 'secondary',
      prompt: createGmailDrafterPrompt(),
      permission: {
        ...createPermissionConfig({
          allToolPatterns,
          allowPatterns: ['mcp__google-gmail__*', 'mcp__google-drive__*', 'mcp__google-people__*'],
        }),
      },
    },
    explore: {
      description: 'Read-only codebase and file-system investigation specialist.',
      color: 'accent',
    },
    build: {
      description: 'Legacy full-access agent. Cowork uses the `cowork` primary agent instead.',
    },
  }
}
