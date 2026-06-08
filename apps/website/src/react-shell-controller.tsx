import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppApi } from '@open-cowork/ui/app-api'
import { CLOUD_WEB_AUTH_REQUIRED_EVENT } from './app-api.ts'
import type { CloudWebClientBootstrap } from './client-contract.ts'
import type { CloudWebRoute } from './app-shell.ts'
import { useCloudWebState } from './react-state.ts'
import { asRecord, errorMessage, setCloudStatus } from './react-workbench-controller.ts'

function canManage(role: unknown) {
  return role === 'owner' || role === 'admin'
}

function text(value: unknown, fallback = '') {
  return String(value ?? fallback)
}

function hashRoute() {
  return window.location.hash.replace(/^#/, '')
}

type ViewTransitionDocument = Document & {
  startViewTransition?: (callback: () => void) => unknown
}

function canUseViewTransition() {
  return Boolean(
    (document as ViewTransitionDocument).startViewTransition
    && !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
}

function runViewTransition(callback: () => void) {
  if (canUseViewTransition()) {
    ;(document as ViewTransitionDocument).startViewTransition?.(callback)
    return
  }
  callback()
}

function routeById(routes: CloudWebRoute[], routeId: string | null | undefined) {
  return routes.find((route) => route.id === routeId) || null
}

function setText(id: string, value: string) {
  const element = document.getElementById(id)
  if (element) element.textContent = value
}

function textNodeElement<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, value: string) {
  const element = document.createElement(tag)
  if (className) element.className = className
  element.textContent = value
  return element
}

function fallbackButton(label: string, title: string, attributes: Record<string, string> = {}) {
  const button = document.createElement('button')
  button.type = 'button'
  button.disabled = true
  button.title = title
  button.textContent = label
  for (const [name, value] of Object.entries(attributes)) button.setAttribute(name, value)
  return button
}

function restoreSignedOutChatFallback(profileName: string, chatEnabled: boolean) {
  setInspectorOpen(false)
  document.body.dataset.chatState = 'empty'
  setText('chat-session-title', 'What shall we cowork on today?')
  setText('chat-session-meta', 'Ask anything, or @mention a coworker')

  const managedActions = document.getElementById('chat-managed-actions')
  if (managedActions) {
    const actionCluster = document.createElement('div')
    actionCluster.className = 'ui-action-cluster cloud-chat-action-cluster'
    actionCluster.setAttribute('role', 'toolbar')
    actionCluster.setAttribute('aria-label', 'Cloud chat actions')
    actionCluster.dataset.actionCluster = 'true'
    actionCluster.append(
      fallbackButton('Cloud model', 'Model selection is managed by this cloud workspace', { class: 'ui-action-cluster__item', 'data-action-id': 'cloud-model', 'data-managed-control': 'true' }),
      fallbackButton('Think Auto', 'Reasoning is managed by this cloud workspace', { class: 'ui-action-cluster__item', 'data-action-id': 'reasoning', 'data-managed-control': 'true' }),
      fallbackButton(profileName || 'default', 'Active cloud profile', { class: 'ui-action-cluster__item', 'data-action-id': 'profile', 'data-managed-control': 'true' }),
    )
    const reviewButton = document.createElement('button')
    reviewButton.className = 'ghost chat-inspector-toggle'
    reviewButton.id = 'chat-inspector-toggle'
    reviewButton.type = 'button'
    reviewButton.setAttribute('aria-controls', 'chat-inspector')
    reviewButton.setAttribute('aria-expanded', 'false')
    reviewButton.textContent = 'Review'
    managedActions.replaceChildren(actionCluster, reviewButton)
  }

  const timeline = document.getElementById('chat-timeline')
  if (timeline) {
    timeline.hidden = false
    timeline.replaceChildren(textNodeElement('p', 'empty', 'Start a conversation from the composer.'))
  }

  const form = document.getElementById('prompt-form') as HTMLFormElement | null
  if (form) {
    form.removeAttribute('data-react-owned')
    form.setAttribute('aria-label', 'Chat composer')
    const label = textNodeElement('label', 'sr-only', 'Message')
    label.setAttribute('for', 'chat-message-input')

    const leadRow = document.createElement('div')
    leadRow.className = 'composer-lead-row'
    leadRow.dataset.hasLead = 'false'
    const leadAvatar = textNodeElement('span', 'studio-coworker-avatar studio-coworker-avatar--sm', 'OC')
    leadAvatar.setAttribute('aria-hidden', 'true')
    leadRow.append(leadAvatar, textNodeElement('span', '', 'Lead coworker: profile default'))

    const inputChrome = document.createElement('div')
    inputChrome.className = 'composer-input-chrome'
    const textarea = document.createElement('textarea')
    textarea.id = 'chat-message-input'
    textarea.className = 'chat-composer-textarea'
    textarea.name = 'text'
    textarea.rows = 1
    textarea.disabled = true
    textarea.placeholder = 'Ask anything, or @mention a coworker'
    inputChrome.append(textarea)

    const chips = document.createElement('div')
    chips.className = 'composer-agent-chips'
    chips.id = 'composer-agent-chips'
    chips.setAttribute('aria-label', 'Coworker shortcuts')

    const toolbar = document.createElement('div')
    toolbar.className = 'composer-toolbar'
    toolbar.setAttribute('aria-label', 'Chat controls')
    const leftGroup = document.createElement('div')
    leftGroup.className = 'composer-toolbar-group'
    leftGroup.append(
      fallbackButton('', 'Cloud file attachments use project snapshots from Projects', { class: 'icon-button ghost', 'data-composer-attach': 'true', 'data-managed-control': 'true', 'aria-label': 'Attach file' }),
    )
    const selectLabel = document.createElement('label')
    selectLabel.className = 'composer-select-label'
    selectLabel.append(textNodeElement('span', 'sr-only', 'Coworker'))
    const select = document.createElement('select')
    select.id = 'composer-agent'
    select.name = 'agent'
    select.disabled = true
    const option = document.createElement('option')
    option.value = ''
    option.textContent = 'Default coworker'
    select.append(option)
    selectLabel.append(select)
    leftGroup.append(selectLabel)

    const rightGroup = document.createElement('div')
    rightGroup.className = 'composer-toolbar-group'
    const status = document.createElement('span')
    status.className = 'pill'
    status.id = 'chat-event-status'
    status.dataset.kind = 'warn'
    status.textContent = chatEnabled ? 'sign in' : 'disabled'
    const send = document.createElement('button')
    send.className = 'composer-send'
    send.type = 'submit'
    send.disabled = true
    send.setAttribute('aria-label', 'Send message')
    send.append(textNodeElement('span', 'sr-only', 'Send message'))
    rightGroup.append(status, send)
    toolbar.append(leftGroup, rightGroup)
    form.replaceChildren(label, leadRow, inputChrome, chips, toolbar)
  }

  const inspectorDetail = document.getElementById('chat-inspector-detail')
  if (inspectorDetail) {
    inspectorDetail.replaceChildren(textNodeElement('p', 'empty', 'Details appear after a conversation starts.'))
  }
}

function setInspectorOpen(open: boolean) {
  const panel = document.getElementById('chat-inspector') as HTMLElement | null
  const toggle = document.getElementById('chat-inspector-toggle') as HTMLElement | null
  const layout = document.querySelector<HTMLElement>('[data-workbench-layout="true"]')
  if (!panel) return
  panel.hidden = !open
  if (layout) {
    layout.dataset.reviewOpen = open ? 'true' : 'false'
    layout.classList.toggle('ui-workbench-layout--with-review', open)
  }
  toggle?.setAttribute('aria-expanded', open ? 'true' : 'false')
  if (open) {
    document.body.dataset.reviewPane = 'open'
    window.requestAnimationFrame(() => {
      const focusTarget = panel.querySelector<HTMLElement>('[role="tab"][aria-selected="true"], button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
      focusTarget?.focus()
    })
  } else {
    delete document.body.dataset.reviewPane
    toggle?.focus()
  }
}

function setInspectorTab(tab: string) {
  const panel = document.getElementById('chat-inspector-detail')
  for (const button of document.querySelectorAll<HTMLElement>('[data-chat-inspector-tab]')) {
    const active = button.dataset.chatInspectorTab === tab
    button.dataset.active = active ? 'true' : 'false'
    button.setAttribute('aria-selected', active ? 'true' : 'false')
    button.tabIndex = active ? 0 : -1
    if (active && button.id) panel?.setAttribute('aria-labelledby', button.id)
  }
}

function setAdminControlState(locked: boolean, reason: string, surfaces: CloudWebClientBootstrap['adminSurfaces'] = []) {
  for (const control of document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>('[data-admin-control="true"]')) {
    control.disabled = locked
    control.dataset.locked = locked ? 'true' : 'false'
    if (locked) {
      const routeId = control.closest<HTMLElement>('[data-route-panel]')?.dataset.routePanel
      const disabledReason = surfaces.find((surface) => surface.routeId === routeId)?.disabledReason || reason
      control.title = disabledReason
      control.setAttribute('aria-label', `${control.textContent?.trim() || control.getAttribute('aria-label') || 'Control'} - ${disabledReason}`)
    } else {
      control.removeAttribute('title')
      control.removeAttribute('aria-label')
    }
  }
}

function setChatControlState(disabled: boolean, reason: string) {
  for (const control of document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>('[data-chat-control="true"]')) {
    control.disabled = disabled
    control.dataset.locked = disabled ? 'true' : 'false'
    if (disabled) control.title = reason
    else control.removeAttribute('title')
  }
}

type RouteDomCache = {
  panels: Map<string, HTMLElement[]>
  links: Map<string, HTMLElement[]>
  adminNav: HTMLDetailsElement[]
}

function pushRouteElement<T extends HTMLElement>(map: Map<string, T[]>, routeId: string | undefined, element: T) {
  if (!routeId) return
  const elements = map.get(routeId)
  if (elements) elements.push(element)
  else map.set(routeId, [element])
}

function buildRouteDomCache(): RouteDomCache {
  const panels = new Map<string, HTMLElement[]>()
  const links = new Map<string, HTMLElement[]>()
  for (const panel of document.querySelectorAll<HTMLElement>('[data-route-panel]')) pushRouteElement(panels, panel.dataset.routePanel, panel)
  for (const link of document.querySelectorAll<HTMLElement>('[data-route-link]')) pushRouteElement(links, link.dataset.routeLink, link)
  return {
    panels,
    links,
    adminNav: Array.from(document.querySelectorAll<HTMLDetailsElement>('[data-admin-nav]')),
  }
}

function setPanelActive(panel: HTMLElement, active: boolean) {
  const hidden = !active
  const ariaHidden = active ? 'false' : 'true'
  if (panel.hidden !== hidden) panel.hidden = hidden
  if (panel.getAttribute('aria-hidden') !== ariaHidden) panel.setAttribute('aria-hidden', ariaHidden)
}

function setLinkActive(link: HTMLElement, active: boolean) {
  const activeValue = active ? 'true' : 'false'
  if (link.dataset.active !== activeValue) link.dataset.active = activeValue
  if (active) {
    if (link.getAttribute('aria-current') !== 'page') link.setAttribute('aria-current', 'page')
  } else if (link.hasAttribute('aria-current')) {
    link.removeAttribute('aria-current')
  }
}

export function CloudReactShellController({ bootstrap }: { bootstrap: CloudWebClientBootstrap }) {
  const api = useAppApi()
  const { state, dispatch } = useCloudWebState()
  const [principal, setPrincipal] = useState<Record<string, unknown> | null>(null)
  const initialIdentityLoadedRef = useRef(false)
  const routeDomCacheRef = useRef<RouteDomCache | null>(null)
  const activeRouteIdRef = useRef<string | null>(null)
  const routeVisibilityKeyRef = useRef<string | null>(null)

  const routes = bootstrap.routes
  const currentRole = useMemo(() => {
    const workspace = asRecord(state.workspace)
    return workspace.role || principal?.role || bootstrap.role
  }, [bootstrap.role, principal, state.workspace])
  const signedIn = state.authStatus === 'signed-in'
  const adminLocked = !canManage(currentRole)

  const canViewRoute = useCallback((route: CloudWebRoute | null) => {
    if (!route) return false
    if (route.requiresAuth && !signedIn) return false
    if (route.requiresAdmin && adminLocked) return false
    return true
  }, [adminLocked, signedIn])

  const defaultRoute = useCallback(() => {
    const preferred = routeById(routes, bootstrap.defaultRoute)
    if (canViewRoute(preferred)) return preferred as CloudWebRoute
    return routes.find(canViewRoute) || routeById(routes, 'org') || routes[0]
  }, [bootstrap.defaultRoute, canViewRoute, routes])

  const resolveRoute = useCallback((routeId: string | null | undefined) => {
    const requested = routeById(routes, routeId)
    return canViewRoute(requested) ? requested as CloudWebRoute : defaultRoute()
  }, [canViewRoute, defaultRoute, routes])

  const applyRouteDom = useCallback((route: CloudWebRoute) => {
    const cache = routeDomCacheRef.current ?? buildRouteDomCache()
    routeDomCacheRef.current = cache

    const previousRouteId = activeRouteIdRef.current
    const visibilityKey = `${signedIn ? 'signed-in' : 'signed-out'}:${adminLocked ? 'admin-locked' : 'admin-open'}`
    const refreshVisibility = routeVisibilityKeyRef.current !== visibilityKey

    if (previousRouteId === null) {
      for (const [routeId, panels] of cache.panels) {
        for (const panel of panels) setPanelActive(panel, routeId === route.id)
      }
    } else if (previousRouteId !== route.id) {
      for (const panel of cache.panels.get(previousRouteId) || []) setPanelActive(panel, false)
      for (const panel of cache.panels.get(route.id) || []) setPanelActive(panel, true)
    }

    if (refreshVisibility) {
      for (const [routeId, links] of cache.links) {
        const linkRoute = routeById(routes, routeId)
        const visible = canViewRoute(linkRoute)
        const active = linkRoute?.id === route.id
        for (const link of links) {
          if (link.hidden !== !visible) link.hidden = !visible
          setLinkActive(link, active)
          if (linkRoute?.requiresAdmin && adminLocked) {
            const label = `${linkRoute.label} - admin permissions required`
            if (link.dataset.locked !== 'true') link.dataset.locked = 'true'
            if (link.getAttribute('aria-label') !== label) link.setAttribute('aria-label', label)
          } else {
            if (link.dataset.locked !== 'false') link.dataset.locked = 'false'
            if (link.hasAttribute('aria-label')) link.removeAttribute('aria-label')
          }
        }
      }
      routeVisibilityKeyRef.current = visibilityKey
    } else if (previousRouteId !== route.id) {
      for (const link of cache.links.get(previousRouteId || '') || []) setLinkActive(link, false)
      for (const link of cache.links.get(route.id) || []) setLinkActive(link, true)
    }

    for (const details of cache.adminNav) {
      const open = route.surface === 'admin'
      if (details.open !== open) details.open = open
    }
    activeRouteIdRef.current = route.id
    if (document.body.dataset.route !== route.id) document.body.dataset.route = route.id
    if (document.body.dataset.surface !== route.surface) document.body.dataset.surface = route.surface
  }, [adminLocked, canViewRoute, routes, signedIn])

  const navigate = useCallback((routeId: string | null | undefined, replace = false) => {
    const route = resolveRoute(routeId)
    const nextHash = `#${route.id}`
    if (window.location.hash !== nextHash) {
      if (replace) window.history.replaceState(null, '', nextHash)
      else window.history.pushState(null, '', nextHash)
    }
    const routeChanged = activeRouteIdRef.current !== null && activeRouteIdRef.current !== route.id
    if (routeChanged) runViewTransition(() => applyRouteDom(route))
    else applyRouteDom(route)
  }, [applyRouteDom, resolveRoute])

  const signOut = useCallback((message = 'Sign in required') => {
    api.setCsrfToken?.(null)
    dispatch({ type: 'csrf', csrfToken: null })
    dispatch({ type: 'workspace', workspace: null })
    dispatch({ type: 'auth', authStatus: 'signed-out' })
    setPrincipal(null)
    setCloudStatus(message, 'warn')
    navigate(bootstrap.defaultRoute, true)
  }, [api, bootstrap.defaultRoute, dispatch, navigate])

  useEffect(() => {
    const handleAuthRequired = () => signOut()
    window.addEventListener(CLOUD_WEB_AUTH_REQUIRED_EVENT, handleAuthRequired)
    return () => window.removeEventListener(CLOUD_WEB_AUTH_REQUIRED_EVENT, handleAuthRequired)
  }, [signOut])

  const refreshIdentity = useCallback(async () => {
    setCloudStatus('Loading workspace', 'warn')
    try {
      const auth = asRecord(await api.auth.me())
      const csrfToken = typeof auth.csrfToken === 'string' ? auth.csrfToken : null
      api.setCsrfToken?.(csrfToken)
      dispatch({ type: 'csrf', csrfToken })
      setPrincipal(asRecord(auth.principal))

      await api.config.current().catch(() => null)
      const workspace = await api.workspace.current()
      dispatch({ type: 'workspace', workspace })
      dispatch({ type: 'auth', authStatus: 'signed-in' })
      setCloudStatus('Ready', 'ok')
      return workspace
    } catch {
      signOut()
      return null
    }
  }, [api, dispatch, signOut])

  useEffect(() => {
    document.body.dataset.reactShell = 'active'
    if (!initialIdentityLoadedRef.current) {
      initialIdentityLoadedRef.current = true
      void refreshIdentity()
    }
    return () => {
      delete document.body.dataset.reactShell
    }
  }, [refreshIdentity])

  useEffect(() => {
    document.body.dataset.auth = state.authStatus
    const workspace = asRecord(state.workspace)
    const productName = text(asRecord(bootstrap.publicBranding).productName, 'Open Cowork Cloud')
    const org = text(workspace.orgName || workspace.tenantName || productName)
    const profile = text(workspace.profileName || bootstrap.profileName || 'default')
    const role = text(currentRole || (signedIn ? 'member' : 'signed out'))
    const email = text(workspace.email || principal?.email)

    setText('org-name', signedIn ? org : productName)
    setText('org-meta', signedIn && email ? `${email} - ${role} - ${profile}` : signedIn ? `${role} - ${profile}` : 'Sign in to open your cloud workspace')
    setText('profile-name', profile)
    setText('role-name', role)
    setText('workspace-label', signedIn ? org : 'Studio workspace')
    setText('workspace-meta', signedIn && email ? `${email} - ${profile}` : 'Sign in to sync chats')
    setText('profile-summary', profile)

    const adminNotice = document.getElementById('admin-notice') as HTMLElement | null
    if (adminNotice) adminNotice.hidden = !signedIn || !adminLocked
    setAdminControlState(!signedIn || adminLocked, 'Admin permissions are required for this control.', bootstrap.adminSurfaces)
    setChatControlState(!signedIn || bootstrap.features.chat === false, bootstrap.features.chat === false ? 'Chat is disabled by this cloud profile.' : 'Sign in to start or continue chats.')
    if (state.authStatus !== 'loading') {
      if (!signedIn) restoreSignedOutChatFallback(profile, bootstrap.features.chat !== false)
      const requestedRoute = hashRoute()
      navigate(requestedRoute || bootstrap.defaultRoute, true)
    }
  }, [adminLocked, bootstrap.adminSurfaces, bootstrap.defaultRoute, bootstrap.features.chat, bootstrap.profileName, bootstrap.publicBranding, currentRole, navigate, principal, signedIn, state.authStatus, state.workspace])

  useEffect(() => {
    const onHashChange = () => navigate(hashRoute() || bootstrap.defaultRoute, true)
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [bootstrap.defaultRoute, navigate])

  useEffect(() => {
    const handler = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      if (!target) return

      const routeLink = target.closest<HTMLElement>('[data-route-link]')
      if (routeLink) {
        event.preventDefault()
        navigate(routeLink.dataset.routeLink || bootstrap.defaultRoute)
        return
      }

      if (target.closest('#signin, #signin-inline')) {
        event.preventDefault()
        window.location.href = '/auth/login'
        return
      }

      if (target.closest('#logout, [data-logout-control="true"]')) {
        event.preventDefault()
        void api.auth.logout().catch(() => null).finally(() => {
          signOut()
        })
        return
      }

      if (target.closest('#refresh, [data-refresh-dashboard="true"]')) {
        event.preventDefault()
        void refreshIdentity()
          .then((workspace) => {
            const bridge = (window as Window & {
              __openCoworkReactWorkbench?: {
                loadSessions?: (options?: { keepSelection?: boolean, preserveLoadedPages?: boolean }) => Promise<void>
              }
            }).__openCoworkReactWorkbench
            if (workspace) return bridge?.loadSessions?.({ keepSelection: true, preserveLoadedPages: true })
            return undefined
          })
          .catch((error) => setCloudStatus(errorMessage(error), 'warn'))
        return
      }

      if (target.closest('[data-thread-search-focus="true"]')) {
        event.preventDefault()
        if (document.body.dataset.surface === 'admin') {
          navigate('threads')
          window.requestAnimationFrame(() => document.getElementById('thread-query')?.focus())
        } else {
          document.getElementById('sidebar-thread-query')?.focus()
        }
        return
      }

      if (target.closest('#chat-inspector-toggle')) {
        event.preventDefault()
        const panel = document.getElementById('chat-inspector') as HTMLElement | null
        setInspectorOpen(Boolean(panel?.hidden))
        return
      }

      if (target.closest('#chat-inspector-close')) {
        event.preventDefault()
        setInspectorOpen(false)
        return
      }

      const tab = target.closest<HTMLElement>('[data-chat-inspector-tab]')
      if (tab) {
        event.preventDefault()
        setInspectorTab(tab.dataset.chatInspectorTab || 'context')
      }
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      const panel = document.getElementById('chat-inspector') as HTMLElement | null
      if (!panel || panel.hidden) return
      event.preventDefault()
      setInspectorOpen(false)
    }

    document.addEventListener('click', handler, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('click', handler, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [api, bootstrap.defaultRoute, navigate, refreshIdentity, signOut])

  return null
}
