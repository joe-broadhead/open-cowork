import { createRoot, hydrateRoot } from 'react-dom/client'
import { useMemo } from 'react'
import { AppApiProvider } from '@open-cowork/ui/app-api'
import { createCloudWebAppApi } from './app-api.ts'
import { installCloudThemePresetControls } from './cloud-theme-client.ts'
import { CloudReactShellController } from './react-shell-controller.tsx'
import { CloudReactSsrShell } from './react-shell.ts'
import { CloudWebStateProvider } from './react-state.ts'
import { useCloudWebState } from './react-state.ts'
import { CloudReactWorkbench } from './react-workbench-app.tsx'
import type { CloudWebClientBootstrap } from './client-contract.ts'

function readBootstrap(): CloudWebClientBootstrap | null {
  const node = document.getElementById('open-cowork-cloud-bootstrap')
  if (!node?.textContent) return null
  try {
    return JSON.parse(node.textContent) as CloudWebClientBootstrap
  } catch {
    return null
  }
}

function CloudReactClientRoot({ bootstrap }: { bootstrap: CloudWebClientBootstrap }) {
  return (
    <CloudWebStateProvider bootstrap={bootstrap}>
      <CloudReactApiRoot bootstrap={bootstrap} />
    </CloudWebStateProvider>
  )
}

function CloudReactApiRoot({ bootstrap }: { bootstrap: CloudWebClientBootstrap }) {
  const { dispatch } = useCloudWebState()
  const api = useMemo(() => createCloudWebAppApi(bootstrap, {
    onUnauthorized: () => {
      dispatch({ type: 'csrf', csrfToken: null })
      dispatch({ type: 'workspace', workspace: null })
      dispatch({ type: 'auth', authStatus: 'signed-out' })
    },
  }), [bootstrap, dispatch])
  return (
    <AppApiProvider api={api}>
      <CloudReactShellController bootstrap={bootstrap} />
      <CloudSignedInSurfaces bootstrap={bootstrap} />
    </AppApiProvider>
  )
}

function CloudSignedInSurfaces({ bootstrap }: { bootstrap: CloudWebClientBootstrap }) {
  const { state } = useCloudWebState()
  return state.authStatus === 'signed-in' ? <CloudReactWorkbench bootstrap={bootstrap} /> : null
}

const root = document.getElementById('open-cowork-cloud-react-root')
const bootstrap = readBootstrap()
const shell = root?.querySelector('[data-cloud-react-shell]')

if (root && bootstrap && shell) {
  hydrateRoot(root, <CloudReactSsrShell shellHtml={shell.innerHTML} />)
  requestAnimationFrame(() => {
    const controller = document.createElement('div')
    controller.id = 'open-cowork-cloud-react-controller'
    controller.hidden = true
    root.appendChild(controller)
    createRoot(controller).render(<CloudReactClientRoot bootstrap={bootstrap} />)
    installCloudThemePresetControls(bootstrap)
    root.dataset.reactStatus = 'hydrated'
  })
}
