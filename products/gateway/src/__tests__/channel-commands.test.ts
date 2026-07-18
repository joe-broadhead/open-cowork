import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { handleChannelCommand, isPreTrustChannelCommandText, parseChannelCommand } from '../channel-commands.js'
import { clearChannelSessionsForTest, getChannelSession, listChannelSessions, setChannelSession } from '../channel-sessions.js'
import { clearConfigCacheForTest, updateConfig } from '../config.js'
import { clearWorkStateForTest, createHumanGate, createRoadmap, createRoadmapSupervisor, createWorkTask, getDefaultRoadmapSupervisor, getWorkTask, listHumanGates, listProjectBindings, listWorkEvents, loadWorkState, proposeRoadmapCompletion, startWorkTaskRun, upsertAlert, upsertProjectBinding } from '../work-store.js'
import type { ChannelMessage } from '../channels/provider.js'

describe('channel commands', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-channel-commands-test-'))

  afterAll(() => { try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {} })

  beforeEach(() => {
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    delete process.env['TELEGRAM_BOT_TOKEN']
    delete process.env['WHATSAPP_ACCESS_TOKEN']
    clearConfigCacheForTest()
    clearWorkStateForTest(path.join(testDir, 'gateway.db'))
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
    clearChannelSessionsForTest()
    clearConfigCacheForTest()
    // Channel targets fail closed without an allowlist entry, and free text plus
    // privileged commands require a trusted actor; trust the fixture chats here.
    updateConfig({
      security: {
        channelAllowlists: {
          telegram: [
            { chatId: 'chat-1', userIds: ['user-1'] },
            { chatId: 'other-chat', userIds: ['user-1'] },
            { chatId: 'unbound-chat', userIds: ['user-1'] },
            { chatId: 'tg-1', userIds: ['user-1'] },
          ],
          whatsapp: [{ chatId: 'wa-1', userIds: ['user-1'] }],
          discord: [],
        },
      },
    } as any)
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    delete process.env['TELEGRAM_BOT_TOKEN']
  })

  it('parses bot-addressed slash commands', () => {
    expect(parseChannelCommand('/bind@my_bot task task_1')).toEqual({ name: 'bind', args: ['task', 'task_1'], rest: 'task task_1' })
    expect(parseChannelCommand('/commands')).toEqual({ name: 'commands', args: [], rest: '' })
    expect(parseChannelCommand('/needs_attention')).toEqual({ name: 'needs-attention', args: [], rest: '' })
    expect(parseChannelCommand('/reject_question q1')).toEqual({ name: 'reject-question', args: ['q1'], rest: 'q1' })
    expect(parseChannelCommand('not a command')).toBeNull()
  })

  it('creates and binds a new session for the current thread', async () => {
    const reply = await handleChannelCommand(fakeClient(), message('/new Design review', 'topic-1'))

    expect(reply).toContain('Created and bound Session: ses_1')
    expect(getChannelSession('telegram', 'chat-1', 'topic-1')).toBe('ses_1')
  })

  it('binds the current chat to an existing task', async () => {
    const task = createWorkTask({ title: 'Ship channel commands', priority: 'HIGH' })

    const reply = await handleChannelCommand(fakeClient(), message(`/bind issue ${task.id}`))

    expect(reply).toContain(`Bound this chat to Issue ${task.id}`)
    expect(listChannelSessions({ provider: 'telegram', chatId: 'chat-1', threadId: '' })[0]).toMatchObject({
      sessionId: 'ses_1',
      mode: 'task',
      taskId: task.id,
    })
  })

  it('accepts issue and initiative aliases without changing stored binding modes', async () => {
    const client = fakeClient()
    const roadmap = createRoadmap({ title: 'Alias Initiative' })
    const task = createWorkTask({ title: 'Alias Issue', roadmapId: roadmap.id, priority: 'HIGH' })

    const issueReply = await handleChannelCommand(client, message(`/bind issue ${task.id}`))
    const issues = await handleChannelCommand(client, message('/issues'))
    const initiativeReply = await handleChannelCommand(client, message(`/bind initiative ${roadmap.id}`, 'topic-alias'))
    const initiatives = await handleChannelCommand(client, message('/initiatives'))

    expect(issueReply).toContain(`Issue ${task.id}`)
    expect(issues).toContain(`Alias Issue (${task.id})`)
    expect(initiativeReply).toContain(`Project ${roadmap.id}`)
    expect(initiatives).toContain(`Alias Initiative (${roadmap.id})`)
    expect(listChannelSessions({ provider: 'telegram', chatId: 'chat-1', threadId: '' })[0]).toMatchObject({
      mode: 'task',
      taskId: task.id,
    })
    expect(listChannelSessions({ provider: 'telegram', chatId: 'chat-1', threadId: 'topic-alias' })[0]).toMatchObject({
      mode: 'roadmap',
      roadmapId: roadmap.id,
    })
  })

  it('shows the current bound task without requiring an id', async () => {
    const client = fakeClient()
    const task = createWorkTask({ title: 'Ship channel shortcuts', priority: 'HIGH' })
    await handleChannelCommand(client, message(`/bind issue ${task.id}`))

    const reply = await handleChannelCommand(client, message('/current'))

    expect(reply).toContain('Current binding: issue')
    expect(reply).toContain('Issue: Ship channel shortcuts')
    expect(reply).toContain('OpenCode Web:')
  })

  it('applies bound task actions without repeating the task id', async () => {
    const client = fakeClient()
    const task = createWorkTask({ title: 'Pause from chat', priority: 'MEDIUM' })
    await handleChannelCommand(client, message(`/bind issue ${task.id}`))

    const reply = await handleChannelCommand(client, message('/pause waiting on user'))

    expect(reply).toContain('pause: Pause from chat')
    expect(reply).toContain('Status: paused')
    expect(getWorkTask(task.id)?.status).toBe('paused')
  })

  it('routes trusted channel actions through active-run controls for running issues', async () => {
    const client = fakeClient()
    const task = createWorkTask({ title: 'Retry from chat', priority: 'HIGH', pipeline: ['implement', 'verify'] })
    startWorkTaskRun(task.id, 'implement', 'ses_channel_retry', 'implementer', undefined, { owner: 'daemon-a', leaseMs: 60 * 60 * 1000, generation: 'gen-a' })!
    await handleChannelCommand(client, message(`/bind issue ${task.id}`))

    const reply = await handleChannelCommand(client, message('/retry try the verification step again'))
    const stored = getWorkTask(task.id)

    expect(reply).toContain('retry: Retry from chat')
    expect(reply).toContain('Outcome: applied')
    expect(reply).toContain('Reason: applied')
    expect(reply).toContain('Restart behavior: durable_requeue_only')
    expect(stored).toMatchObject({ status: 'pending', currentStage: 'implement', currentRunId: undefined })
  })

  it('lists and resolves Gateway human gates from chat', async () => {
    const client = fakeClient()
    const task = createWorkTask({ title: 'Approve from chat', priority: 'HIGH', manualGate: 'approval_required' })
    await handleChannelCommand(client, message(`/bind issue ${task.id}`))
    const [gate] = listHumanGates({ status: 'open' })

    const listed = await handleChannelCommand(client, message('/gates'))
    const approved = await handleChannelCommand(client, message(`/gate approve ${gate!.id} once looks good`))

    expect(listed).toContain(gate!.id)
    expect(approved).toContain(`approve: ${gate!.id}`)
    expect(approved).toContain('Status: approved')
    expect(getWorkTask(task.id)?.manualGate).toBeUndefined()
  })

  it('lists and approves roadmap completion proposals from chat', async () => {
    const client = fakeClient()
    const roadmap = createRoadmap({ title: 'Complete from chat' })
    await handleChannelCommand(client, message(`/bind initiative ${roadmap.id}`))
    const proposal = proposeRoadmapCompletion({ roadmapId: roadmap.id, evidence: ['verified'], recommendation: 'ready' }).proposal

    const listed = await handleChannelCommand(client, message('/completion'))
    const approved = await handleChannelCommand(client, message(`/completion approve ${proposal.id} ship it`))

    expect(listed).toContain(proposal.id)
    expect(approved).toContain(`Completion approve: ${proposal.id}`)
    expect(approved).toContain('Status: approved')
    expect(loadWorkState().roadmaps.find(row => row.id === roadmap.id)?.status).toBe('done')
  })

  it('shows and acknowledges active alerts from chat', async () => {
    const alert = upsertAlert({ key: 'test:chat-alert', severity: 'warning', source: 'manual.test', summary: 'Chat alert', nextAction: 'Acknowledge it' }).alert

    const listed = await handleChannelCommand(fakeClient(), message('/alerts'))
    const acked = await handleChannelCommand(fakeClient(), message(`/alert ack ${alert.id} seen`))

    expect(listed).toContain('Chat alert')
    expect(acked).toContain('Status: acknowledged')
  })

  it('creates a supervised project from chat and exposes status and digest without ids', async () => {
    const client = fakeClient()

    const created = await handleChannelCommand(client, message('/project create alpha Alpha Project'))
    const roadmap = loadWorkState().roadmaps[0]
    createWorkTask({ roadmapId: roadmap!.id, title: 'Implement alpha', priority: 'HIGH' })
    const status = await handleChannelCommand(client, message('/p status'))
    const digest = await handleChannelCommand(client, message('/digest'))

    expect(created).toContain('Project created: alpha')
    expect(loadWorkState().supervisors[0]).toMatchObject({ roadmapId: roadmap!.id, sessionId: 'ses_1', status: 'active', isDefault: true })
    expect(listChannelSessions({ provider: 'telegram', chatId: 'chat-1' })[0]).toMatchObject({ mode: 'roadmap', roadmapId: roadmap!.id })
    expect(status).toContain('Project: alpha')
    expect(status).toContain('Issues: 1 pending')
    expect(digest).toContain('Project digest: alpha')
    expect(digest).toContain('roadmap.supervisor.created')
  })

  it('does not silently replace an existing project binding', async () => {
    const client = fakeClient()
    await handleChannelCommand(client, message('/project create alpha Alpha Project'))

    const rejected = await handleChannelCommand(client, message('/project create beta Beta Project'))

    expect(rejected).toContain('This chat is already bound to project alpha')
    expect(loadWorkState().roadmaps).toHaveLength(1)
  })

  it('creates a fresh assistant session when creating a project over an existing channel binding', async () => {
    const client = fakeClient()
    await handleChannelCommand(client, message('/new Earlier channel session'))

    const created = await handleChannelCommand(client, message('/project create beta Beta Project --rebind'))

    expect(created).toContain('Project created: beta')
    expect(created).toContain('Session: ses_2')
    expect(listProjectBindings({ alias: 'beta' })[0]).toMatchObject({ sessionId: 'ses_2' })
    expect(listChannelSessions({ provider: 'telegram', chatId: 'chat-1' })[0]).toMatchObject({
      sessionId: 'ses_2',
      mode: 'roadmap',
    })
  })

  it('queues project reviews idempotently from chat', async () => {
    const client = fakeClient()
    await handleChannelCommand(client, message('/project create alpha Alpha Project'))

    const first = await handleChannelCommand(client, message('/project review-now'))
    const second = await handleChannelCommand(client, message('/project review-now'))

    expect(first).toContain('Project review: queued')
    expect(second).toContain('Project review: not queued')
    expect(second).toContain('already queued')
  })

  it('approves the current project completion proposal without repeating ids', async () => {
    const client = fakeClient()
    await handleChannelCommand(client, message('/project create alpha Alpha Project'))
    const roadmap = loadWorkState().roadmaps[0]
    proposeRoadmapCompletion({ roadmapId: roadmap!.id, evidence: ['verified'], recommendation: 'ready' })

    const approved = await handleChannelCommand(client, message('/project complete approve ship it'))

    expect(approved).toContain('Completion approve:')
    expect(loadWorkState().roadmaps.find(row => row.id === roadmap!.id)?.status).toBe('done')
  })

  it('mutes and restores project notifications with watch shortcuts', async () => {
    const client = fakeClient()
    await handleChannelCommand(client, message('/project create alpha Alpha Project'))

    const muted = await handleChannelCommand(client, message('/project unwatch'))
    const watched = await handleChannelCommand(client, message('/watch'))

    expect(muted).toContain('Notifications: muted')
    expect(watched).toContain('Notifications: immediate')
    expect(listProjectBindings({ alias: 'alpha' })[0]).toMatchObject({ notificationMode: 'immediate' })
  })

  it('updates project notification policy from chat', async () => {
    const client = fakeClient()
    await handleChannelCommand(client, message('/project create alpha Alpha Project'))

    const digest = await handleChannelCommand(client, message('/project notify digest'))
    const quiet = await handleChannelCommand(client, message('/project quiet 22:00 07:00'))
    const quietOff = await handleChannelCommand(client, message('/project quiet off'))

    expect(digest).toContain('Notifications: digest')
    expect(quiet).toContain('Quiet hours: 22:00-07:00 UTC')
    expect(quietOff).toContain('Quiet hours: off')
    expect(listProjectBindings({ alias: 'alpha' })[0]).toMatchObject({ notificationMode: 'digest', quietHours: {} })
  })

  it('returns the bound session OpenCode link with /open', async () => {
    const client = fakeClient()
    await handleChannelCommand(client, message('/new Design review'))

    const reply = await handleChannelCommand(client, message('/open'))

    expect(reply).toContain('OpenCode Web:')
    expect(reply).toContain('Web recovery: if Web says the session was not found')
    expect(reply).toContain('OpenCode TUI: opencode /tmp/opencode-gateway-test --session ses_1')
    expect(reply).toContain('Mission Control: http://127.0.0.1:4097/dashboard')
    expect(reply).toContain('Session evidence: http://127.0.0.1:4097/opencode/sessions/ses_1')
    expect(reply).toContain('ses_1')
  })

  it('falls back to a TUI resume command when Web link metadata is missing', async () => {
    const client = fakeClient({ noDirectory: ['ses_nopath'] })

    const bound = await handleChannelCommand(client, message('/bind session ses_nopath'))
    const opened = await handleChannelCommand(client, message('/open'))

    expect(bound).toContain('OpenCode Web: unavailable (session metadata missing directory/path)')
    expect(bound).toContain('OpenCode TUI: opencode --session ses_nopath')
    expect(opened).toContain('OpenCode Web: unavailable (session metadata missing directory/path)')
    expect(opened).toContain('OpenCode TUI: opencode --session ses_nopath')
    expect(opened).toContain('Mission Control: http://127.0.0.1:4097/dashboard')
    expect(opened).toContain('Session evidence: http://127.0.0.1:4097/opencode/sessions/ses_nopath')
  })

  it('shows channel context with /whereami', async () => {
    const client = fakeClient()
    await handleChannelCommand(client, message('/project create alpha Alpha Project'))

    const reply = await handleChannelCommand(client, message('/whereami'))

    expect(reply).toContain('Channel target: telegram:target:')
    expect(reply).not.toContain('telegram:chat-1')
    expect(reply).toContain('Trust: trusted')
    expect(reply).toContain('Bound Session: ses_1 context=project')
    expect(reply).toContain('Project: alpha')
    expect(reply).toContain('Notification mode: immediate')
  })

  it('presents a guided command center instead of a flat command dump', async () => {
    const reply = await handleChannelCommand(fakeClient(), message('/commands'))

    expect(reply).toContain('Gateway Command Center')
    expect(reply).toContain('Start here:')
    expect(reply).toContain('/project create <alias> <title>')
    expect(reply).toContain('/p, /digest, /watch, /unwatch')
    expect(reply).toContain('/completion [list|approve|reject]')
    expect(reply).toContain('Attention and governance:')
    expect(reply).toContain('Channel UX truth:')
    expect(reply).toContain('Telegram: / menu completes command verbs only')
    expect(reply).toContain('arguments/subcommands stay typed/copy fallback')
    expect(reply).toContain('Telegram typing: bounded trusted-chat feedback')
    expect(reply).toContain('OpenCode permissions/questions are channel fallbacks')
    expect(reply).toContain('no universal-channel or WhatsApp-live claim')
  })

  it('binds an existing session and requires explicit rebind on conflicts', async () => {
    const client = fakeClient()
    await handleChannelCommand(client, message('/new Design review'))

    const rejected = await handleChannelCommand(client, message('/bind session ses_2'))
    const rebound = await handleChannelCommand(client, message('/bind session ses_2 --rebind'))

    expect(rejected).toContain('already bound to Session ses_1')
    expect(rebound).toContain('Session bound: ses_2')
    expect(getChannelSession('telegram', 'chat-1')).toBe('ses_2')
  })

  it('hands off an existing OpenCode session from Telegram to WhatsApp', async () => {
    const client = fakeClient()

    const created = await handleChannelCommand(client, message('/new Durable session', undefined, 'telegram', 'tg-1'))
    const bound = await handleChannelCommand(client, message('/bind session ses_1', undefined, 'whatsapp', 'wa-1'))
    const current = await handleChannelCommand(client, message('/current', undefined, 'whatsapp', 'wa-1'))

    expect(created).toContain('Created and bound Session: ses_1')
    expect(bound).toContain('Session bound: ses_1')
    expect(current).toContain('Session: ses_1')
    expect(current).toContain('OpenCode Web:')
    expect(current).toContain('OpenCode TUI: opencode /tmp/opencode-gateway-test --session ses_1')
    expect(listChannelSessions({ sessionId: 'ses_1' }).map(link => `${link.provider}:${link.chatId}`).sort()).toEqual(['telegram:tg-1', 'whatsapp:wa-1'])
  })

  it('switches active project context explicitly and lists relevant sessions', async () => {
    const client = fakeClient()
    const alpha = createRoadmap({ title: 'Alpha Project' })
    const beta = createRoadmap({ title: 'Beta Project' })
    createRoadmapSupervisor({ roadmapId: alpha.id, sessionId: 'ses_alpha' })
    createRoadmapSupervisor({ roadmapId: beta.id, sessionId: 'ses_beta' })
    upsertProjectBinding({ alias: 'beta', roadmapId: beta.id, sessionId: 'ses_beta' })
    await handleChannelCommand(client, message(`/project bind alpha ${alpha.id}`))

    const switched = await handleChannelCommand(client, message('/switch beta'))
    const sessions = await handleChannelCommand(client, message('/session'))

    expect(switched).toContain('Switched this chat to project: beta')
    expect(switched).toContain('Session: ses_beta')
    expect(sessions).toContain('ses_beta')
    expect(sessions).toContain(`project=${beta.id}`)
  })

  it('recovers stale project supervisor sessions during explicit rebind', async () => {
    const client = fakeClient({ missing: ['ses_stale'] })
    const roadmap = createRoadmap({ title: 'Recovery Project' })
    const supervisor = createRoadmapSupervisor({ roadmapId: roadmap.id, sessionId: 'ses_stale', isDefault: true })

    const rebound = await handleChannelCommand(client, message(`/project bind recovery ${roadmap.id} --rebind`))
    const opened = await handleChannelCommand(client, message('/project open recovery'))

    expect(rebound).toContain('Project bound: recovery')
    expect(rebound).toContain('Recovery: replaced unavailable Project Session ses_stale with ses_1.')
    expect(rebound).toContain('Session: ses_1')
    expect(opened).toContain('OpenCode Web:')
    expect(opened).toContain('/session/ses_1')
    expect(opened).not.toContain('/session/ses_stale')
    expect(getDefaultRoadmapSupervisor(roadmap.id)?.sessionId).toBe('ses_1')
    expect(getDefaultRoadmapSupervisor(roadmap.id)?.supervisorId).toBe(supervisor.supervisorId)
  })

  it('recovers stale project sessions when switching from another channel', async () => {
    const client = fakeClient({ missing: ['ses_stale'] })
    const roadmap = createRoadmap({ title: 'Switch Recovery' })
    createRoadmapSupervisor({ roadmapId: roadmap.id, sessionId: 'ses_stale', isDefault: true })
    upsertProjectBinding({ alias: 'switchable', roadmapId: roadmap.id, sessionId: 'ses_stale' })

    const switched = await handleChannelCommand(client, message('/switch switchable', undefined, 'whatsapp', 'wa-1'))

    expect(switched).toContain('Switched this chat to project: switchable')
    expect(switched).toContain('Recovery: replaced unavailable Project Session ses_stale with ses_1.')
    expect(switched).toContain('Session: ses_1')
    expect(switched).toContain('OpenCode TUI: opencode /tmp/opencode-gateway-test --session ses_1')
  })

  it('prefers a live supervisor session when a project binding points at a stale session', async () => {
    const client = fakeClient({ missing: ['ses_stale'] })
    const roadmap = createRoadmap({ title: 'Supervisor Reuse' })
    createRoadmapSupervisor({ roadmapId: roadmap.id, sessionId: 'ses_live', isDefault: true })
    upsertProjectBinding({ alias: 'reuse', roadmapId: roadmap.id, sessionId: 'ses_stale' })

    const switched = await handleChannelCommand(client, message('/switch reuse', undefined, 'whatsapp', 'wa-1'))

    expect(switched).toContain('Switched this chat to project: reuse')
    expect(switched).toContain('Recovery: replaced unavailable Project Session ses_stale with Supervisor Session ses_live.')
    expect(switched).toContain('Session: ses_live')
    expect(switched).toContain('OpenCode TUI: opencode /tmp/opencode-gateway-test --session ses_live')
    expect(switched).not.toContain('Session: ses_1')
  })

  it('opens requested run and issue sessions when resolvable', async () => {
    const client = fakeClient()
    const task = createWorkTask({ title: 'Open from issue', priority: 'HIGH' })
    const run = startWorkTaskRun(task.id, 'implement', 'ses_run', 'implementer')!.run

    const runReply = await handleChannelCommand(client, message(`/open run ${run.id}`))
    const issueReply = await handleChannelCommand(client, message(`/open issue ${task.id}`))

    expect(runReply).toContain('ses_run')
    expect(issueReply).toContain('ses_run')
  })

  it('opens stale requested sessions with recovery guidance instead of dead Web links', async () => {
    const client = fakeClient({ missing: ['ses_stale_open'] })

    const opened = await handleChannelCommand(client, message('/open ses_stale_open'))

    expect(opened).toContain('OpenCode Web: unavailable (session not found in OpenCode API)')
    expect(opened).toContain('Web recovery: Use /new [title], /switch <sessionId>, or /project bind <alias> <roadmapId> --rebind')
    expect(opened).toContain('OpenCode TUI: opencode --session ses_stale_open')
    expect(opened).toContain('Session evidence: http://127.0.0.1:4097/opencode/sessions/ses_stale_open')
    expect(opened).not.toContain('/session/ses_stale_open')
  })

  it('switches to missing sessions with recovery guidance instead of a dead end', async () => {
    const client = fakeClient({ missing: ['ses_missing_switch'] })

    const switched = await handleChannelCommand(client, message('/switch ses_missing_switch'))

    expect(switched).toContain('OpenCode Web: unavailable (session not found in OpenCode API)')
    expect(switched).toContain('Web recovery: Use /new [title], /switch <sessionId>, or /project bind <alias> <roadmapId> --rebind')
    expect(switched).toContain('OpenCode TUI: opencode --session ses_missing_switch')
    expect(switched).toContain('Mission Control: http://127.0.0.1:4097/dashboard')
    expect(switched).toContain('Session evidence: http://127.0.0.1:4097/opencode/sessions/ses_missing_switch')
    expect(switched).not.toContain('/session/ses_missing_switch')
  })

  it('binds missing sessions with recovery guidance instead of a dead end', async () => {
    const client = fakeClient({ missing: ['ses_missing_bind'] })

    const bound = await handleChannelCommand(client, message('/bind session ses_missing_bind --rebind'))

    expect(bound).toContain('OpenCode Web: unavailable (session not found in OpenCode API)')
    expect(bound).toContain('OpenCode TUI: opencode --session ses_missing_bind')
    expect(bound).toContain('Session evidence: http://127.0.0.1:4097/opencode/sessions/ses_missing_bind')
    expect(bound).not.toContain('/session/ses_missing_bind')
  })

  it('shows recovery guidance on status when the bound session disappeared', async () => {
    const client = fakeClient({ missing: ['ses_missing_status'] })
    setChannelSession('telegram', 'chat-1', 'ses_missing_status')

    const status = await handleChannelCommand(client, message('/status'))

    expect(status).toContain('Binding: ses_missing_status context=chat')
    expect(status).toContain('OpenCode Web: unavailable (session not found in OpenCode API)')
    expect(status).toContain('OpenCode TUI: opencode --session ses_missing_status')
    expect(status).toContain('Session evidence: http://127.0.0.1:4097/opencode/sessions/ses_missing_status')
    expect(status).not.toContain('/session/ses_missing_status')
  })

  it('rejects sensitive commands from untrusted channel targets', async () => {
    process.env['TELEGRAM_BOT_TOKEN'] = '12345:abcdefghijklmnopqrstuvwxyz'
    clearConfigCacheForTest()
    updateConfig({ security: { channelAllowlists: { telegram: [{ chatId: 'trusted-chat' }], whatsapp: [] } } } as any)

    const denied = await handleChannelCommand(fakeClient(), message('/project status'))
    const help = await handleChannelCommand(fakeClient(), message('/help'))
    const where = await handleChannelCommand(fakeClient(), message('/whereami'))

    expect(denied).toContain('Channel target is not trusted: telegram:target:')
    expect(denied).not.toContain('telegram:chat-1')
    expect(help).toContain('Gateway setup')
    expect(help).toContain('This channel is not trusted yet, so only setup-safe commands are available.')
    expect(help).toContain('Safe before trust')
    expect(help).not.toContain('/status')
    expect(where).toContain('Trust: untrusted')
    expect(where).toContain('Channel target: telegram:target:')
    expect(where).not.toContain('telegram:chat-1')
    expect(where).not.toContain('Bound Session:')
    expect(isPreTrustChannelCommandText('/start')).toBe(true)
    expect(isPreTrustChannelCommandText('/commands')).toBe(true)
    expect(isPreTrustChannelCommandText('/whereami')).toBe(true)
    expect(isPreTrustChannelCommandText('/status')).toBe(false)
  })

  it('requires an allowed channel actor for privileged commands in shared chats', async () => {
    process.env['TELEGRAM_BOT_TOKEN'] = '12345:abcdefghijklmnopqrstuvwxyz'
    clearConfigCacheForTest()
    updateConfig({ security: { channelAllowlists: { telegram: [{ chatId: 'group-1' }], whatsapp: [], discord: [] } } } as any)

    const denied = await handleChannelCommand(fakeClient(), message('/project create alpha Alpha Project', undefined, 'telegram', 'group-1'))

    expect(denied).toContain('Privileged channel action denied')
    expect(denied).toContain('Decision owner: Gateway channel security; State: denied.')
    expect(loadWorkState().roadmaps).toHaveLength(0)

    updateConfig({ security: { channelAllowlists: { telegram: [{ chatId: 'group-1', adminUserIds: ['user-1'] }], whatsapp: [], discord: [] } } } as any)
    const allowed = await handleChannelCommand(fakeClient(), message('/project create alpha Alpha Project', undefined, 'telegram', 'group-1'))

    expect(allowed).toContain('Project created: alpha')
    expect(loadWorkState().roadmaps).toHaveLength(1)
  })

  it('treats unknown or new commands as privileged by default in shared chats', async () => {
    updateConfig({ security: { channelAllowlists: { telegram: [{ chatId: 'group-1' }], whatsapp: [], discord: [] } } } as any)

    // Fail closed: a command name missing from the read-only allowlist runs the
    // per-sender actor preflight even though the switch would only print help.
    const denied = await handleChannelCommand(fakeClient(), message('/brand-new-mutation now', undefined, 'telegram', 'group-1', { messageId: 'unknown-cmd-1' }))
    expect(denied).toContain('Privileged channel action denied')

    // Known read-only commands stay available to any member of the trusted target.
    const status = await handleChannelCommand(fakeClient(), message('/status', undefined, 'telegram', 'group-1'))
    expect(status).not.toContain('Privileged channel action denied')

    // Session rebinds are privileged even though /session list stays read-only.
    const rebind = await handleChannelCommand(fakeClient(), message('/session select ses_1', undefined, 'telegram', 'group-1', { messageId: 'unknown-cmd-2' }))
    expect(rebind).toContain('Privileged channel action denied')
    const listed = await handleChannelCommand(fakeClient(), message('/session list', undefined, 'telegram', 'group-1'))
    expect(listed).not.toContain('Privileged channel action denied')

    updateConfig({ security: { channelAllowlists: { telegram: [{ chatId: 'group-1', adminUserIds: ['user-1'] }], whatsapp: [], discord: [] } } } as any)
    const allowed = await handleChannelCommand(fakeClient(), message('/brand-new-mutation now', undefined, 'telegram', 'group-1', { messageId: 'unknown-cmd-3' }))
    expect(allowed).toContain('Unknown command: /brand-new-mutation')
  })

  it('denies human gate decisions from the wrong channel identity', async () => {
    const client = fakeClient()
    const task = createWorkTask({ title: 'Wrong channel gate', priority: 'HIGH', manualGate: 'approval_required' })
    await handleChannelCommand(client, message(`/bind issue ${task.id}`))
    const [gate] = listHumanGates({ status: 'open' })

    const denied = await handleChannelCommand(client, message(`/gate approve ${gate!.id} once`, undefined, 'telegram', 'other-chat', { messageId: 'wrong-gate-1' }))

    expect(denied).toContain('Action denied: this channel is not bound to that human gate.')
    expect(denied).toContain('Decision owner: Gateway channel security; State: denied.')
    expect(denied).toContain('Switch or bind the trusted channel')
    expect(listHumanGates({ status: 'open' })[0]?.id).toBe(gate!.id)
    expect(getWorkTask(task.id)?.manualGate).toBe('approval_required')
  })

  it('denies expired human gate decisions before applying the action', async () => {
    const client = fakeClient()
    const task = createWorkTask({ title: 'Expired gate', priority: 'HIGH' })
    const gate = createHumanGate({
      type: 'task_start',
      taskId: task.id,
      reason: 'Expired approval',
      expiresAt: '2000-01-01T00:00:00.000Z',
      timeoutAction: 'block',
    })
    await handleChannelCommand(client, message(`/bind issue ${task.id}`))

    const denied = await handleChannelCommand(client, message(`/gate approve ${gate.id} once`, undefined, 'telegram', 'chat-1', { messageId: 'expired-gate-1' }))

    expect(denied).toContain('Action denied: Gateway human gate has expired.')
    expect(denied).toContain('Decision owner: Gateway channel security; State: expired.')
    expect(listHumanGates({ status: 'open' })[0]?.id).toBe(gate.id)
  })

  it('denies stale privileged channel actions before applying the action', async () => {
    const client = fakeClient()
    const task = createWorkTask({ title: 'Stale gate', priority: 'HIGH', manualGate: 'approval_required' })
    await handleChannelCommand(client, message(`/bind issue ${task.id}`))
    const [gate] = listHumanGates({ status: 'open' })

    const denied = await handleChannelCommand(client, message(`/gate approve ${gate!.id} once`, undefined, 'telegram', 'chat-1', {
      messageId: 'stale-gate-1',
      timestamp: '2000-01-01T00:00:00.000Z',
    }))

    expect(denied).toContain('Action denied: this channel action is too old to process.')
    expect(denied).toContain('Decision owner: Gateway channel security; State: stale.')
    expect(denied).toContain('Refresh the current attention item')
    expect(getWorkTask(task.id)?.manualGate).toBe('approval_required')
  })

  it('denies replayed native channel actions without reapplying side effects', async () => {
    const client = fakeClient()
    const task = createWorkTask({ title: 'Replay gate', priority: 'HIGH', manualGate: 'approval_required' })
    await handleChannelCommand(client, message(`/bind issue ${task.id}`))
    const [gate] = listHumanGates({ status: 'open' })
    const callback = message(`/gate approve ${gate!.id} once`, undefined, 'telegram', 'chat-1', { messageId: 'replay-gate-1' })

    const approved = await handleChannelCommand(client, callback)
    const replayed = await handleChannelCommand(client, callback)

    expect(approved).toContain(`approve: ${gate!.id}`)
    expect(replayed).toContain('Action denied: this channel action was already processed.')
    expect(replayed).toContain('Decision owner: Gateway channel security; State: stale.')
    expect(getWorkTask(task.id)?.manualGate).toBeUndefined()
  })

  it('denies replayed privileged actions even when the provider omits message ids', async () => {
    const client = fakeClient()
    const callback = message('/new Replay-safe session', undefined, 'telegram', 'chat-1', {
      messageId: undefined,
      timestamp: new Date().toISOString(),
    })

    const created = await handleChannelCommand(client, callback)
    const replayed = await handleChannelCommand(client, callback)

    expect(created).toContain('Created and bound Session: ses_1')
    expect(replayed).toContain('Action denied: this channel action was already processed.')
    expect(replayed).toContain('Decision owner: Gateway channel security; State: stale.')
    expect(listChannelSessions({ provider: 'telegram', chatId: 'chat-1', threadId: '' })).toHaveLength(1)
    const serializedEvents = JSON.stringify(listWorkEvents(100).filter(row => row.type === 'channel.action.accepted' || row.type === 'audit.security'))
    expect(serializedEvents).toContain('fallback')
    expect(serializedEvents).not.toContain('Replay-safe session')
    expect(serializedEvents).not.toContain('chat-1')
  })

  it('denies completion proposal actions outside the bound project', async () => {
    const client = fakeClient()
    const bound = createRoadmap({ title: 'Bound project' })
    const other = createRoadmap({ title: 'Other project' })
    await handleChannelCommand(client, message(`/bind initiative ${bound.id}`))
    const proposal = proposeRoadmapCompletion({ roadmapId: other.id, evidence: ['verified'], recommendation: 'ready' }).proposal

    const denied = await handleChannelCommand(client, message(`/completion approve ${proposal.id}`, undefined, 'telegram', 'chat-1', { messageId: 'wrong-completion-1' }))

    expect(denied).toContain('Action denied: this channel is not bound to that completion proposal.')
    expect(loadWorkState().completionProposals.find(row => row.id === proposal.id)?.status).toBe('pending')
    expect(loadWorkState().roadmaps.find(row => row.id === other.id)?.status).toBe('active')
  })

  it('denies unbound trusted channels from approving the only active supervisor completion proposal', async () => {
    const roadmap = createRoadmap({ title: 'Single supervisor completion' })
    createRoadmapSupervisor({ roadmapId: roadmap.id, sessionId: 'ses_supervisor' })
    const proposal = proposeRoadmapCompletion({ roadmapId: roadmap.id, evidence: ['verified'], recommendation: 'ready' }).proposal

    const denied = await handleChannelCommand(fakeClient(), message(`/completion approve ${proposal.id}`, undefined, 'telegram', 'unbound-chat', { messageId: 'unbound-completion-1' }))

    expect(denied).toContain('Action denied: this channel is not bound to that completion proposal.')
    expect(loadWorkState().completionProposals.find(row => row.id === proposal.id)?.status).toBe('pending')
    expect(loadWorkState().roadmaps.find(row => row.id === roadmap.id)?.status).toBe('active')
  })

  it('denies unbound trusted channels from approving the only active supervisor human gate', async () => {
    const roadmap = createRoadmap({ title: 'Single supervisor gate' })
    createRoadmapSupervisor({ roadmapId: roadmap.id, sessionId: 'ses_supervisor' })
    const task = createWorkTask({ title: 'Gated under supervisor', roadmapId: roadmap.id, manualGate: 'approval_required' })
    const [gate] = listHumanGates({ status: 'open' })

    const denied = await handleChannelCommand(fakeClient(), message(`/gate approve ${gate!.id} once`, undefined, 'telegram', 'unbound-chat', { messageId: 'unbound-gate-1' }))

    expect(denied).toContain('Action denied: this channel is not bound to that human gate.')
    expect(listHumanGates({ status: 'open' })[0]?.id).toBe(gate!.id)
    expect(getWorkTask(task.id)?.manualGate).toBe('approval_required')
  })

  it('denies unscoped destructive human gates even from a currently bound trusted channel', async () => {
    const task = createWorkTask({ title: 'Bound but unscoped destructive gate' })
    await handleChannelCommand(fakeClient(), message(`/bind issue ${task.id}`))
    const gate = createHumanGate({
      type: 'destructive_action',
      reason: 'Delete local database',
      requestedBy: 'test',
      scopeKey: 'destructive:test',
    })

    const denied = await handleChannelCommand(fakeClient(), message(`/gate approve ${gate.id} once`, undefined, 'telegram', 'chat-1', { messageId: 'unscoped-destructive-gate-1' }))

    expect(denied).toContain('Action denied: this channel is not bound to that human gate.')
    expect(listHumanGates({ status: 'open' })[0]?.id).toBe(gate.id)
  })

  it('denies unbound trusted channels from mutating raw issues under the only active supervisor', async () => {
    const roadmap = createRoadmap({ title: 'Single supervisor task' })
    createRoadmapSupervisor({ roadmapId: roadmap.id, sessionId: 'ses_supervisor' })
    const task = createWorkTask({ title: 'Raw task under supervisor', roadmapId: roadmap.id })

    const denied = await handleChannelCommand(fakeClient(), message(`/issue done ${task.id}`, undefined, 'telegram', 'unbound-chat', { messageId: 'unbound-task-1' }))

    expect(denied).toContain('Action denied: this channel is not bound to that Issue.')
    expect(getWorkTask(task.id)?.status).toBe('pending')
  })

  it('requires OpenCode permission replies to match the bound session', async () => {
    const calls = mockOpenCodeRequests({
      permissions: [{ id: 'perm_1', sessionID: 'ses_permission', permission: 'bash', patterns: ['npm test'], metadata: {}, always: [] }],
    })
    setChannelSession('telegram', 'chat-1', 'ses_permission')

    const approved = await handleChannelCommand(fakeClient(), message('/approve perm_1 once', undefined, 'telegram', 'chat-1', { messageId: 'perm-approve-1' }))

    expect(approved).toContain('Approved permission perm_1 (once).')
    expect(approved).toContain('Forwarded to OpenCode')
    expect(approved).toContain('OpenCode owns the final permission receipt')
    expect(calls).toEqual([{ path: '/permission/perm_1/reply', body: { reply: 'once' } }])
  })

  it('denies OpenCode permission replies for another session', async () => {
    const calls = mockOpenCodeRequests({
      permissions: [{ id: 'perm_2', sessionID: 'ses_other', permission: 'edit', patterns: ['src/**'], metadata: {}, always: [] }],
    })
    setChannelSession('telegram', 'chat-1', 'ses_bound')

    const denied = await handleChannelCommand(fakeClient(), message('/approve perm_2 once', undefined, 'telegram', 'chat-1', { messageId: 'perm-deny-1' }))

    expect(denied).toContain('Action denied: this channel is not bound to that OpenCode Session.')
    expect(denied).toContain('Decision owner: Gateway channel security; State: denied.')
    expect(denied).toContain('Authority: Gateway channel security owns replay')
    expect(calls).toEqual([])
  })

  it('answers and rejects OpenCode questions through typed fallbacks', async () => {
    const calls = mockOpenCodeRequests({
      questions: [{ id: 'question_1', sessionID: 'ses_question', questions: [{ header: 'Choice', question: 'Pick one?', options: [{ label: 'A' }] }] }],
    })
    setChannelSession('telegram', 'chat-1', 'ses_question')

    const answered = await handleChannelCommand(fakeClient(), message('/answer question_1 A', undefined, 'telegram', 'chat-1', { messageId: 'question-answer-1' }))
    const rejected = await handleChannelCommand(fakeClient(), message('/reject_question question_1', undefined, 'telegram', 'chat-1', { messageId: 'question-reject-1' }))

    expect(answered).toContain('Answered question question_1.')
    expect(answered).toContain('OpenCode owns the final question receipt')
    expect(rejected).toContain('Rejected question question_1.')
    expect(rejected).toContain('Forwarded to OpenCode')
    expect(calls).toEqual([
      { path: '/question/question_1/reply', body: { answers: [['A']] } },
      { path: '/question/question_1/reject', body: undefined },
    ])
  })

  it('denies replayed OpenCode permission callbacks without leaking raw channel targets', async () => {
    const calls = mockOpenCodeRequests({
      permissions: [{ id: 'perm_3', sessionID: 'ses_permission', permission: 'bash', patterns: ['npm test'], metadata: {}, always: [] }],
    })
    setChannelSession('telegram', 'chat-1', 'ses_permission')
    const callback = message('/approve perm_3 once', undefined, 'telegram', 'chat-1', { messageId: 'perm-replay-1' })

    const approved = await handleChannelCommand(fakeClient(), callback)
    const replayed = await handleChannelCommand(fakeClient(), callback)

    expect(approved).toContain('Approved permission perm_3 (once).')
    expect(replayed).toContain('Action denied: this channel action was already processed.')
    expect(replayed).toContain('Decision owner: Gateway channel security; State: stale.')
    expect(replayed).toContain('Evidence: channel_action:opencode_permission.reply:replayed')
    expect(calls).toEqual([{ path: '/permission/perm_3/reply', body: { reply: 'once' } }])
    const actionEvents = listWorkEvents(100).filter(row => row.type === 'channel.action.accepted' || row.type === 'audit.security')
    const serializedEvents = JSON.stringify(actionEvents)
    expect(serializedEvents).toContain('channel.action.accepted')
    expect(serializedEvents).toContain('replayed')
    expect(serializedEvents).toContain('operatorDecision')
    expect(serializedEvents).not.toContain('chat-1')
  })

  it('reports missing session and context behavior deterministically', async () => {
    const open = await handleChannelCommand(fakeClient({ missing: ['missing'] }), message('/open session missing'))
    const current = await handleChannelCommand(fakeClient(), message('/current'))

    expect(open).toContain('OpenCode Web: unavailable (session not found in OpenCode API)')
    expect(open).toContain('Web recovery: Use /new [title], /switch <sessionId>, or /project bind <alias> <roadmapId> --rebind to recover a fresh session.')
    expect(open).toContain('OpenCode TUI: opencode --session missing')
    expect(open).toContain('Session evidence: http://127.0.0.1:4097/opencode/sessions/missing')
    expect(open).not.toContain('/session/missing')
    expect(current).toContain('No binding found')
  })

  it('shows recovery links for a latest run whose OpenCode session disappeared', async () => {
    const client = fakeClient({ missing: ['ses_missing_run'] })
    const task = createWorkTask({ title: 'Missing run session', priority: 'HIGH' })
    startWorkTaskRun(task.id, 'implement', 'ses_missing_run', 'implementer')!
    await handleChannelCommand(client, message(`/bind issue ${task.id}`))

    const reply = await handleChannelCommand(client, message('/latest'))

    expect(reply).toContain('Latest run for Missing run session')
    expect(reply).toContain('Session: ses_missing_run')
    expect(reply).toContain('OpenCode Web: unavailable (session not found in OpenCode API)')
    expect(reply).toContain('OpenCode TUI: opencode --session ses_missing_run')
    expect(reply).not.toContain('/session/ses_missing_run')
  })

  function fakeClient(options: { missing?: string[]; noDirectory?: string[] } = {}) {
    let next = 1
    return {
      session: {
        create: async ({ body }: any) => ({ data: { id: `ses_${next++}`, title: body.title, directory: '/tmp/opencode-gateway-test' } }),
        get: async ({ path: p }: any) => {
          if (options.missing?.includes(p.id)) throw new Error('not found')
          if (options.noDirectory?.includes(p.id)) return { data: { id: p.id, title: 'GW:Existing' } }
          return { data: { id: p.id, title: 'GW:Existing', directory: '/tmp/opencode-gateway-test' } }
        },
      },
    }
  }

  function message(text: string, threadId?: string, provider = 'telegram', chatId = 'chat-1', options: Partial<ChannelMessage> = {}): ChannelMessage {
    return { provider, chatId, threadId, userId: 'user-1', text, timestamp: new Date().toISOString(), attachments: [], ...options }
  }

  function mockOpenCodeRequests(input: { permissions?: any[]; questions?: any[] }) {
    const calls: Array<{ path: string; body: any }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      const pathName = new URL(String(url)).pathname
      if ((init?.method || 'GET').toUpperCase() === 'POST') {
        calls.push({ path: pathName, body: init?.body ? JSON.parse(String(init.body)) : undefined })
        return jsonResponse({ ok: true })
      }
      if (pathName === '/permission') return jsonResponse(input.permissions || [])
      if (pathName === '/question') return jsonResponse(input.questions || [])
      return jsonResponse([])
    }))
    return calls
  }

  function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
})
