import { argValue, hasArg } from '../shared.js'

export async function environmentCommand() {
  const sub = process.argv[3] || 'help'
  const product = await import('../../product-onboarding.js')
  if (sub !== 'template') {
    console.log(`Usage: opencode-gateway env template <${product.ENVIRONMENT_TEMPLATE_KINDS.join('|')}> [directory] [--stdout] [--force]`)
    return
  }
  const kind = (process.argv[4] || 'generic') as any
  const dirArg = process.argv[5] && !process.argv[5].startsWith('--') ? process.argv[5] : process.cwd()
  if (hasArg('--stdout')) {
    console.log(product.buildEnvironmentTemplate(kind).trimEnd())
    return
  }
  const written = product.writeEnvironmentTemplate(kind, argValue('--dir') || dirArg, { force: hasArg('--force') })
  console.log(`${written.created ? 'Created' : 'Kept existing'} ${written.path}`)
}
