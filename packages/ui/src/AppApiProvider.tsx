import { createContext, useContext, type ReactNode } from 'react'
import type { AppAPI } from '@open-cowork/shared'

const AppApiContext = createContext<AppAPI | null>(null)

export type AppApiProviderProps = {
  api: AppAPI
  children: ReactNode
}

export function AppApiProvider({ api, children }: AppApiProviderProps) {
  return (
    <AppApiContext.Provider value={api}>
      {children}
    </AppApiContext.Provider>
  )
}

export function useAppApi() {
  const api = useContext(AppApiContext)
  if (!api) {
    throw new Error('useAppApi must be used inside AppApiProvider')
  }
  return api
}
