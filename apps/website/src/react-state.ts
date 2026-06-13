import { createContext, createElement, useContext, useMemo, useReducer, type Dispatch, type ReactNode } from 'react'
import type { CloudWebClientBootstrap, CloudWebClientStateContract } from './client-contract.ts'
import type { CloudWebRouteId } from './app-shell.ts'

export type CloudWebReactAction =
  | { type: 'auth'; authStatus: CloudWebClientStateContract['authStatus'] }
  | { type: 'csrf'; csrfToken: string | null }
  | { type: 'route'; activeRoute: CloudWebRouteId }
  | { type: 'workspace'; workspace: unknown | null }
  | { type: 'selected-session'; selectedSessionId: string | null }

export type CloudWebReactStateContext = {
  bootstrap: CloudWebClientBootstrap
  state: CloudWebClientStateContract
  dispatch: Dispatch<CloudWebReactAction>
}

const CloudWebStateContext = createContext<CloudWebReactStateContext | null>(null)

export function initialCloudWebClientState(bootstrap: CloudWebClientBootstrap): CloudWebClientStateContract {
  return {
    authStatus: 'loading',
    activeRoute: bootstrap.defaultRoute as CloudWebRouteId,
    workspace: null,
    csrfToken: null,
    selectedSessionId: null,
    sessionSelectionGeneration: 0,
    sessions: [],
    sessionList: {
      nextCursor: null,
      hasMore: false,
      isLoading: false,
      isLoadingMore: false,
      lastSyncedAt: null,
      totalEstimate: null,
      error: null,
    },
    sessionViews: {},
    runtimeActions: {},
    artifactPanel: {
      sessionId: null,
      artifactId: null,
      metadata: null,
      status: 'idle',
      error: null,
    },
    capabilities: {
      tools: [],
      skills: [],
      error: null,
    },
    workflows: {
      workflows: [],
      runs: [],
      error: null,
    },
    channels: {
      providers: [],
      agents: [],
      bindings: [],
      people: [],
      deliveries: [],
      watches: [],
      error: null,
    },
    usageSummary: null,
    deliveries: [],
    diagnostics: null,
    diagnosticsError: null,
    admin: {
      policy: null,
      members: [],
      workerPools: [],
      workers: [],
      auditEvents: [],
      error: null,
      workerError: null,
    },
    selectedWorkflowId: null,
    workspaceEvents: {
      status: 'idle',
      cursor: 0,
      error: null,
    },
    sessionEvents: {
      status: 'idle',
      sessionId: null,
      cursor: 0,
      error: null,
    },
  }
}

function reducer(state: CloudWebClientStateContract, action: CloudWebReactAction): CloudWebClientStateContract {
  if (action.type === 'auth') return state.authStatus === action.authStatus ? state : { ...state, authStatus: action.authStatus }
  if (action.type === 'csrf') return state.csrfToken === action.csrfToken ? state : { ...state, csrfToken: action.csrfToken }
  if (action.type === 'route') return state.activeRoute === action.activeRoute ? state : { ...state, activeRoute: action.activeRoute }
  if (action.type === 'workspace') return state.workspace === action.workspace ? state : { ...state, workspace: action.workspace }
  if (action.type === 'selected-session') {
    return {
      ...state,
      selectedSessionId: action.selectedSessionId,
      sessionSelectionGeneration: state.sessionSelectionGeneration + 1,
    }
  }
  return state
}

export function CloudWebStateProvider({ bootstrap, children }: { bootstrap: CloudWebClientBootstrap; children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, bootstrap, initialCloudWebClientState)
  const value = useMemo(() => ({ bootstrap, state, dispatch }), [bootstrap, state])
  return createElement(CloudWebStateContext.Provider, { value }, children)
}

export function useCloudWebState() {
  const context = useContext(CloudWebStateContext)
  if (!context) throw new Error('useCloudWebState must be used inside CloudWebStateProvider')
  return context
}
