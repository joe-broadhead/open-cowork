export const TEAM_CONTEXT_PREFIX = '[[COWORK_INTERNAL_TEAM_CONTEXT]]'
export const TEAM_SYNTHESIZE_PREFIX = '[[COWORK_INTERNAL_TEAM_SYNTHESIZE]]'
export const MAX_TEAM_BRANCHES = 10

export const TEAM_AGENT_NAMES = ['research', 'explore', 'analyst']

export const TEAM_INTENT_PATTERN = /(deep research|research|audit|review|meeting prep|prepare .* meeting|compare|investigate)/i

export const COWORK_ORCHESTRATION_RULES = [
  'Use direct tools only for simple single-surface work.',
  'Delegate sub-agent work through the task tool when a dedicated agent or an independent branch would be more reliable.',
  'Do not use Nova, charts, or Google Workspace MCP tools directly in the parent thread; route that work through the right sub-agent.',
  'Use todowrite to track meaningful multi-step work in the parent thread.',
  `Keep at most ${MAX_TEAM_BRANCHES} concurrent child tasks.`,
  'Do not create nested subtasks from child agents.',
  'Never run two writer agents against the same target document, sheet, draft, or file at the same time.',
]

export const COWORK_PARALLEL_RULES = [
  'When the user names multiple independent topics, questions, or audit dimensions, spawn one child task per branch in the same step instead of serializing them.',
  'For multi-topic meeting prep, deep research, and codebase audits, default to immediate parallel fanout unless one branch depends on another.',
  'Do not wait for one independent research branch to finish before launching the others.',
  'When a request names N independent research topics, launch exactly N child tasks for those topics before you start waiting on results.',
  'If you describe work as parallel, issue all of those child task calls before you start waiting on results or synthesizing.',
  'Do not tell the user you launched multiple parallel tasks unless at least two child tasks are actually in flight.',
]

export const COWORK_DELEGATION_RULES = [
  'Use analyst for Nova metrics, SQL, evidence gathering, and chart generation.',
  'Use research for external documentation, standards, meeting prep, vendor/framework comparison, and deep web research.',
  'Use explore for read-only codebase and file-system investigation.',
  'Use sheets-builder for Google Sheets output, formatting, and charts.',
  'Use docs-writer for Google Docs output.',
  'Use gmail-drafter for Gmail drafts and email preparation.',
  'When Atlassian Rovo MCP is enabled, use its bundled Jira and Confluence skills for project tracking, status reporting, and knowledge search.',
  'When Amplitude MCP is enabled, use its bundled Amplitude skills for product analytics, dashboards, experiments, replays, and instrumentation planning.',
  'When GitHub MCP is enabled, use it for repositories, issues, pull requests, Actions, and code security workflows.',
]

export const COWORK_TODO_RULES = [
  'Create a todo list before starting any task with multiple meaningful steps, multiple deliverables, or parallel branches.',
  'Keep the todo list short, action-oriented, and user-relevant.',
  'Update todo status as work starts, completes, or becomes blocked.',
  'For parallel child tasks, use the todo list to reflect the parent execution plan and overall progress.',
  'When a child task completes, reconcile the parent todo list immediately so finished branches are marked complete before the final synthesis.',
  'Do not create todos for trivial one-step answers that can be completed immediately.',
]

export const COWORK_EXECUTION_RULES = [
  'Give every child task a clear title, expected output, and sub-agent to use.',
  'If parallel fanout is obviously appropriate, dispatch the child tasks first and update todos after they are in flight.',
  'When several branches use the same sub-agent, create separate child tasks anyway instead of collapsing them into one broad task.',
  'For deep research across several named topics, the first execution step after todo setup should be the child task calls, not a long parent-thread explanation.',
  'Merge child outputs into a concise parent response with links and artifacts.',
  'Ask before sending email or creating documents that will be shared externally.',
  'Present results with evidence, especially for analytics work.',
]

export const TEAM_PLANNER_SYSTEM_LINES = [
  'You are deciding whether a Cowork request should fan out into a deterministic sub-agent team.',
  'Return JSON only.',
  'Set shouldFanOut=true only when the user clearly asked for multiple independent research, audit, or review branches that can run in parallel.',
  'Prefer research for external docs, standards, and meeting prep.',
  'Prefer explore for codebase and file-system audits.',
  'Prefer analyst for clearly data-analysis branches.',
  `Return at most ${MAX_TEAM_BRANCHES} branches.`,
  'Each branch prompt should be self-contained and focused on one independent branch only.',
]

export const TEAM_BRANCH_EXECUTION_RULES = [
  'Work this branch directly yourself.',
  'Do not create todos.',
  'Do not claim you are launching parallel streams.',
  'Do not create subtasks or additional child work.',
  'Use the tools already available to you to complete this one branch.',
  'Return concise findings with evidence and useful links.',
]
