export const pushUniqueQueueValue = <T>(
  map: Map<string, T[]>,
  key: string,
  value: T,
  isEqual: (left: T, right: T) => boolean = Object.is,
) => {
  const current = map.get(key) || []
  if (!current.some((entry) => isEqual(entry, value))) {
    current.push(value)
    map.set(key, current)
  }
}

export const shiftQueueValue = <T>(map: Map<string, T[]>, key: string) => {
  const current = map.get(key) || []
  const value = current.shift()
  if (current.length > 0) map.set(key, current)
  else map.delete(key)
  return value
}

export const spliceQueueValue = <T>(
  map: Map<string, T[]>,
  key: string,
  matcher: (value: T) => boolean,
) => {
  const current = map.get(key) || []
  const index = current.findIndex(matcher)
  if (index < 0) return null
  const [value] = current.splice(index, 1)
  if (current.length > 0) map.set(key, current)
  else map.delete(key)
  return value ?? null
}
