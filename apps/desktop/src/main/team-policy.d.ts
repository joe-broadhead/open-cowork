export const TEAM_CONTEXT_PREFIX: string
export const TEAM_SYNTHESIZE_PREFIX: string
export const MAX_TEAM_BRANCHES: number

export const TEAM_AGENT_NAMES: readonly ['research', 'explore', 'analyst']
export type TeamAgentName = typeof TEAM_AGENT_NAMES[number]

export const TEAM_INTENT_PATTERN: RegExp

export const COWORK_ORCHESTRATION_RULES: readonly string[]
export const COWORK_PARALLEL_RULES: readonly string[]
export const COWORK_DELEGATION_RULES: readonly string[]
export const COWORK_TODO_RULES: readonly string[]
export const COWORK_EXECUTION_RULES: readonly string[]

export const TEAM_PLANNER_SYSTEM_LINES: readonly string[]
export const TEAM_BRANCH_EXECUTION_RULES: readonly string[]
