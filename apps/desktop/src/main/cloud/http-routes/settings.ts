import type { CloudApiRouteInput } from './types.ts'

export async function handleSettingsApiRoute(input: CloudApiRouteInput): Promise<boolean> {
  const { req, res, options, context, itemId: settingId, tools } = input

  if (!options.policy.features.settings) {
    tools.writePolicyError(res, 403, 'Settings are disabled for this cloud profile.', 'settings.disabled', options.corsOrigin)
    return true
  }

  const settingKey = settingId ? decodeURIComponent(settingId) : null
  if (!settingKey && req.method === 'GET') {
    tools.writeJson(res, 200, {
      settings: await options.service.listSettingMetadata(context.principal),
    }, options.corsOrigin)
    return true
  }

  if (settingKey && req.method === 'GET') {
    tools.writeJson(res, 200, {
      setting: await options.service.getSettingMetadata(context.principal, settingKey),
    }, options.corsOrigin)
    return true
  }

  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
    const body = await tools.readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
    const keyName = settingKey || tools.readString(body.key)
    const value = tools.readRecord(body.value)
    if (!keyName || !value) {
      tools.writeError(res, 400, 'Setting key and object value are required.', options.corsOrigin)
      return true
    }
    tools.writeJson(res, 200, {
      setting: await options.service.setSettingMetadata(context.principal, {
        key: keyName,
        value,
      }),
    }, options.corsOrigin)
    return true
  }

  tools.writeError(res, 405, 'Method not allowed.', options.corsOrigin)
  return true
}
