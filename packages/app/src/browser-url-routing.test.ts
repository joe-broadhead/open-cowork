import { describe, expect, it } from 'vitest'
import { appHashFor, parseAppHash } from './browser-url-routing'
import type { AppView } from './app-types'

describe('parseAppHash', () => {
  it('maps the empty and root hash to home', () => {
    expect(parseAppHash('')).toEqual({ view: 'home', sessionId: null })
    expect(parseAppHash('#')).toEqual({ view: 'home', sessionId: null })
    expect(parseAppHash('#/')).toEqual({ view: 'home', sessionId: null })
  })

  it('parses every routable app view', () => {
    const views: AppView[] = ['home', 'projects', 'knowledge', 'approvals', 'playbooks', 'team', 'channels', 'tools', 'artifacts', 'health']
    for (const view of views) {
      expect(parseAppHash(`#/${view}`)).toEqual({ view, sessionId: null })
    }
  })

  it('rejects the removed legacy view aliases', () => {
    expect(parseAppHash('#/threads').view).toBeNull()
    expect(parseAppHash('#/workflows').view).toBeNull()
    expect(parseAppHash('#/agents').view).toBeNull()
    expect(parseAppHash('#/capabilities').view).toBeNull()
  })

  it('parses chat deep links and URI-decodes the session id', () => {
    expect(parseAppHash('#/chat/ses_123')).toEqual({ view: 'chat', sessionId: 'ses_123' })
    expect(parseAppHash('#/chat/a%2Fb')).toEqual({ view: 'chat', sessionId: 'a/b' })
  })

  it('rejects malformed chat links', () => {
    expect(parseAppHash('#/chat').view).toBeNull()
    expect(parseAppHash('#/chat/').view).toBeNull()
    expect(parseAppHash('#/chat/a/b').view).toBeNull()
    expect(parseAppHash('#/chat/%E0%A4%A').view).toBeNull()
  })

  it('gates ui-primitives on devMode', () => {
    expect(parseAppHash('#/ui-primitives').view).toBeNull()
    expect(parseAppHash('#/ui-primitives', { devMode: true }).view).toBe('ui-primitives')
  })

  it('rejects settings, unknown views, junk, and non-slash forms', () => {
    expect(parseAppHash('#/settings').view).toBeNull()
    expect(parseAppHash('#/definitely-not-a-view').view).toBeNull()
    expect(parseAppHash('#projects').view).toBeNull()
    expect(parseAppHash('#/projects/extra').view).toBeNull()
  })
})

describe('appHashFor', () => {
  it('formats plain views', () => {
    expect(appHashFor('projects')).toBe('#/projects')
    expect(appHashFor('home')).toBe('#/home')
  })

  it('formats chat with an encoded session id, falling back to the bare view without one', () => {
    expect(appHashFor('chat', 'ses_123')).toBe('#/chat/ses_123')
    expect(appHashFor('chat', 'a/b')).toBe('#/chat/a%2Fb')
    expect(appHashFor('chat', null)).toBe('#/chat')
  })

  it('round-trips through parseAppHash', () => {
    const views: AppView[] = ['home', 'projects', 'knowledge', 'approvals', 'playbooks', 'team', 'channels', 'tools', 'artifacts', 'health']
    for (const view of views) {
      expect(parseAppHash(appHashFor(view)).view).toBe(view)
    }
    expect(parseAppHash(appHashFor('chat', 'ses_9'))).toEqual({ view: 'chat', sessionId: 'ses_9' })
  })
})
