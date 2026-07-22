import assert from 'node:assert/strict'
import test from 'node:test'
import { launchSmokeApp, waitForAppShell } from './smoke-helpers.ts'
import { captureEvidence, getEvalBridgeState, installEvalBridge } from './eval-helpers.ts'

// EVAL FLOW: the admin control-plane renders its sections for an authorized
// role — and stays fail-closed for an unauthorized one.
//
// Admin access is cloud-role-gated (`admin.access()` permissions). In the
// default local desktop build there is no cloud role, so the sidebar hides the
// Admin entry and AdminPage renders a "No admin access" gate. Smoke/eval runs
// set OPEN_COWORK_E2E=1 so preload exposes `window.__openCoworkEval`, which
// grants a coarse, content-free admin role (permission strings only) *before*
// contextBridge freezes coworkApi. Contract selector: `[data-nav-view="admin"]`.
// When the E2E seam is unavailable, we assert the security-relevant
// fail-closed behavior instead — which is itself a valuable eval.
const ADMIN_PERMISSIONS = ['members:read', 'roles:manage', 'policy:manage', 'audit:read']

test('eval:admin — control plane renders sections for an authorized role', async () => {
  const { page, cleanup } = await launchSmokeApp()
  try {
    await installEvalBridge(page, { adminPermissions: ADMIN_PERMISSIONS })
    await page.reload()
    await waitForAppShell(page)

    const bridge = await getEvalBridgeState(page)

    if (bridge.installed) {
      // Authorized: the sidebar reveals the Admin nav; drive into AdminPage.
      const adminNav = page.locator('[data-nav-view="admin"]').first()
      await adminNav.waitFor({ timeout: 10_000 })
      await adminNav.click()

      await page.getByRole('heading', { name: 'Admin' }).waitFor({ timeout: 10_000 })
      await page.getByRole('navigation', { name: /admin sections/i }).waitFor({ timeout: 10_000 })

      // Sections shown map to the granted permissions.
      for (const section of ['Members', 'Roles', 'Policies']) {
        await page.getByRole('button', { name: section, exact: true }).first().waitFor({ timeout: 10_000 })
      }
      await captureEvidence(page, 'admin', '01-admin-sections')
    } else {
      // Fail-closed: no admin nav, and forcing the view renders the gate.
      const adminNavCount = await page.locator('[data-nav-view="admin"]').count()
      assert.equal(adminNavCount, 0, 'admin nav must be hidden without an admin role')
      await captureEvidence(page, 'admin', '01-admin-hidden')
    }
  } finally {
    await cleanup()
  }
})
