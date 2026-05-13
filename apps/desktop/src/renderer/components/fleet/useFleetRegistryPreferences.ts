import { useMemo, useState } from 'react'
import {
  DEFAULT_FLEET_REGISTRY_SORT,
  readFleetRegistryPreference,
  shouldDefaultFleetRegistryToTable,
  writeFleetRegistryPreference,
  type FleetRegistryPreference,
  type FleetRegistryQuickFilter,
  type FleetRegistrySort,
  type FleetRegistrySurface,
  type FleetRegistryViewMode,
} from './fleet-registry-model'

export function useFleetRegistryPreferences(surface: FleetRegistrySurface, itemCount: number) {
  const [preference, setPreference] = useState<FleetRegistryPreference>(() => readFleetRegistryPreference(surface))

  const effective = useMemo(() => {
    return {
      viewMode: preference.viewMode || (shouldDefaultFleetRegistryToTable(itemCount) ? 'table' : 'cards'),
      quickFilter: preference.quickFilter || 'all',
      sort: preference.sort || DEFAULT_FLEET_REGISTRY_SORT,
    } satisfies Required<FleetRegistryPreference>
  }, [itemCount, preference])

  const updatePreference = (patch: FleetRegistryPreference) => {
    setPreference((current) => {
      const next = { ...current, ...patch }
      writeFleetRegistryPreference(surface, next)
      return next
    })
  }

  return {
    preference,
    viewMode: effective.viewMode,
    quickFilter: effective.quickFilter,
    sort: effective.sort,
    setViewMode: (viewMode: FleetRegistryViewMode) => updatePreference({ viewMode }),
    setQuickFilter: (quickFilter: FleetRegistryQuickFilter) => updatePreference({ quickFilter }),
    setSort: (sort: FleetRegistrySort) => updatePreference({ sort }),
  }
}
