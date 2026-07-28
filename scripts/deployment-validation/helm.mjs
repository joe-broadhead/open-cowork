import {
  commandExists,
  cpSync,
  join,
  log,
  mkdtempSync,
  requireTools,
  rmSync,
  tmpdir,
} from './core.mjs'
import { validateCloudHelm } from './helm-cloud.mjs'
import { validateGatewayHelm } from './helm-gateway.mjs'

export function validateHelm() {
  if (!commandExists('helm', ['version', '--short'])) {
    if (requireTools) throw new Error('helm is required for deployment validation')
    log('helm not found; parsed Helm value checks passed')
    return
  }

  const tempRoot = mkdtempSync(join(tmpdir(), 'open-cowork-deploy-helm-'))
  try {
    cpSync('helm', join(tempRoot, 'helm'), { recursive: true })
    validateCloudHelm(join(tempRoot, 'helm/open-cowork-cloud'))
    validateGatewayHelm(join(tempRoot, 'helm/open-cowork-gateway'))
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}
