export type WebsiteRole = 'owner' | 'admin' | 'member'

export function canManageOrg(role: WebsiteRole | null | undefined) {
  return role === 'owner' || role === 'admin'
}
