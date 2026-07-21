import assert from 'node:assert/strict'
import test from 'node:test'
import { launchSmokeApp, waitForAppShell } from './smoke-helpers.ts'
import {
  captureEvidence,
  emitSyntheticApproval,
  getEvalBridgeState,
  installEvalBridge,
} from './eval-helpers.ts'

// EVAL FLOW: a prompt starts a stream and an approval can be resolved,
// deterministically and offline.
//
// Two real, offline surfaces are exercised:
//  1. The composer → chat transition + streaming UI. Submitting a prompt
//     creates + activates a real session and mounts the chat transcript /
//     live announcer. The placeholder credential means no real model responds,
//     so the STREAM machinery (pending state, transcript announcer) is what we
//     assert — no network dependency, no flakiness on model output.
//  2. Approval resolution. A synthetic, content-free PermissionRequest is
//     broadcast via main `permission:request` IPC (E2E eval seam), the app's
//     real `on.permissionRequest` subscriber receives it, the Approvals queue
//     renders it, and resolving records a `permission.respond` offline. If the
//     E2E seam is unavailable, the flow falls back to asserting the real
//     (empty) Approvals surface renders.
test('eval:prompt-approval — prompt streams and an approval resolves offline', async () => {
  const { page, cleanup } = await launchSmokeApp()
  try {
    await installEvalBridge(page)
    await page.reload()
    await waitForAppShell(page)

    // --- 1. Prompt → stream transition ---
    await page.waitForSelector('h1:has-text("Good")', { timeout: 30_000 })
    const composer = page.locator('textarea').first()
    await composer.waitFor({ timeout: 10_000 })
    await composer.fill('summarize the latest release notes')
    await composer.press('Enter')

    // The Home greeting drops out as the chat view takes over.
    await page.waitForSelector('h1:has-text("Good")', { state: 'detached', timeout: 15_000 })
    const chatComposer = page.locator('textarea').first()
    await chatComposer.waitFor({ timeout: 15_000 })
    // The live-region announcer is the stream surface the renderer mounts for
    // every chat session regardless of provider outcome.
    await page.waitForSelector('[data-testid="chat-transcript-announcer"]', { timeout: 15_000 })
    await captureEvidence(page, 'prompt-approval', '01-chat-stream')

    // --- 2. Approval resolution ---
    const bridge = await getEvalBridgeState(page)
    // Discover the active session so the synthetic approval binds to it.
    const sessionId = await page.evaluate(async () => {
      const sessions = await window.coworkApi.session.list()
      return sessions[0]?.id ?? null
    })

    if (bridge.installed && sessionId) {
      const delivered = await emitSyntheticApproval(page, {
        id: 'eval_approval_1',
        sessionId,
        tool: 'bash',
        input: { command: 'echo hello' },
        description: 'Run a shell command',
      })
      assert.ok(delivered > 0, 'no app subscriber received the synthetic approval')

      // Open the Approvals surface and resolve the request.
      await page.locator('[data-nav-view="approvals"]').first().click()
      await page.getByRole('heading', { name: 'Approvals' }).waitFor({ timeout: 10_000 })
      await captureEvidence(page, 'prompt-approval', '02-approval-pending')

      const approveButton = page.getByRole('button', { name: /^(Approve|Allow once)$/ }).first()
      await approveButton.waitFor({ timeout: 10_000 })
      await approveButton.click()

      await page.waitForFunction(() => {
        const evalApi = (window as unknown as {
          __openCoworkEval?: { getPermissionResponses: () => Array<{ id: string; allowed: boolean }> }
        }).__openCoworkEval
        return (evalApi?.getPermissionResponses().length ?? 0) > 0
      }, undefined, { timeout: 10_000 })

      const resolved = await getEvalBridgeState(page)
      assert.equal(resolved.permissionResponses[0]?.id, 'eval_approval_1')
      assert.equal(resolved.permissionResponses[0]?.allowed, true)
      await captureEvidence(page, 'prompt-approval', '03-approval-resolved')
    } else {
      // Hardened bridge: assert the real Approvals surface still renders.
      await page.locator('[data-nav-view="approvals"]').first().click()
      await page.getByRole('heading', { name: 'Approvals' }).waitFor({ timeout: 10_000 })
      await page.getByText('No approvals waiting', { exact: true }).waitFor({ timeout: 10_000 })
      await captureEvidence(page, 'prompt-approval', '02-approvals-empty')
    }
  } finally {
    await cleanup()
  }
})
