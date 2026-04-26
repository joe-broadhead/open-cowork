let ensureRuntimeDirectoryImpl: ((directory?: string | null) => Promise<void>) | null = null

export function registerRuntimeDirectoryEnsurer(
  impl: ((directory?: string | null) => Promise<void>) | null,
) {
  ensureRuntimeDirectoryImpl = impl
}

export async function ensureRuntimeContextDirectory(directory?: string | null) {
  if (!ensureRuntimeDirectoryImpl) return
  await ensureRuntimeDirectoryImpl(directory)
}
