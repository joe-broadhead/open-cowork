type TokenRefreshOptions = {
  refreshAccessToken: () => Promise<string | null | undefined>
  logError: (message: string) => void
  env?: NodeJS.ProcessEnv
  envKey?: string
}

export async function refreshAccessTokenIntoEnvironment(options: TokenRefreshOptions) {
  const {
    refreshAccessToken,
    logError,
    env = process.env,
    envKey = 'GOOGLE_WORKSPACE_CLI_TOKEN',
  } = options

  try {
    const token = await refreshAccessToken()
    if (token) {
      env[envKey] = token
    }
    return token || null
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logError(`Access token refresh failed: ${message}`)
    return null
  }
}
