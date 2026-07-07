// Decides whether a tagged Windows build proceeds as a signed public
// release or an unsigned preview. Mirrors release-signing-mode.mjs (macOS)
// so the release workflow gates both platforms the same way.
//
// Two signing mechanisms are accepted:
//   1. electron-builder native Authenticode signing via an exportable
//      certificate: WIN_CSC_LINK (base64 .pfx) + WIN_CSC_KEY_PASSWORD.
//      Signing happens during packaging, so latest.yml stays consistent.
//   2. SignPath Foundation (free for OSS) cloud signing, driven post-build
//      by the SignPath GitHub Action: SIGNPATH_API_TOKEN plus the
//      SIGNPATH_ORGANIZATION_ID and SIGNPATH_PROJECT_SLUG repository vars.
//      The post-build path must regenerate latest.yml with
//      scripts/regenerate-windows-update-metadata.mjs before publishing.
//
// Signed mode requires exactly one complete mechanism to be configured.

function isTruthy(value) {
  return /^(1|true|yes)$/i.test((value || '').trim())
}

function present(key) {
  return Boolean(process.env[key]?.trim())
}

const nativeSigning = present('WIN_CSC_LINK') && present('WIN_CSC_KEY_PASSWORD')
const signPathSigning = present('SIGNPATH_API_TOKEN')
  && present('SIGNPATH_ORGANIZATION_ID')
  && present('SIGNPATH_PROJECT_SLUG')

const allowUnsigned = isTruthy(process.env.OPEN_COWORK_ALLOW_UNSIGNED_RELEASES)
const refName = process.env.GITHUB_REF_NAME || ''

if (nativeSigning || signPathSigning) {
  const mechanism = nativeSigning ? 'native-certificate' : 'signpath'
  console.error(`Windows release signing is configured (${mechanism}); building signed artifacts.`)
  process.stdout.write('mode=signed\n')
  process.stdout.write(`mechanism=${mechanism}\n`)
  process.exit(0)
}

if (!allowUnsigned) {
  console.error(
    'Missing Windows signing configuration. Provide WIN_CSC_LINK + WIN_CSC_KEY_PASSWORD ' +
    '(exportable certificate) or the SignPath inputs (SIGNPATH_API_TOKEN + SIGNPATH_ORGANIZATION_ID ' +
    '+ SIGNPATH_PROJECT_SLUG), or explicitly opt into a preview-only unsigned tag release with the ' +
    'OPEN_COWORK_ALLOW_UNSIGNED_RELEASES repository variable.',
  )
  process.exit(1)
}

if (!/^v0\./.test(refName)) {
  console.error(
    'OPEN_COWORK_ALLOW_UNSIGNED_RELEASES is only valid for v0.x preview tags. ' +
    `Ref ${refName || '(unknown)'} must be Authenticode-signed.`,
  )
  process.exit(1)
}

console.error(
  'OPEN_COWORK_ALLOW_UNSIGNED_RELEASES is enabled; building unsigned Windows preview artifacts. ' +
  'This should not be used for public production releases.',
)
process.stdout.write('mode=unsigned\n')
process.stdout.write('mechanism=none\n')
