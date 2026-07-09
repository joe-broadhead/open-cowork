// Decides whether a tagged Windows build proceeds as a signed public
// release or an unsigned preview. Mirrors release-signing-mode.mjs (macOS)
// so the release workflow gates both platforms the same way.
//
// The only supported signed mode is electron-builder native Authenticode
// signing via an exportable certificate: WIN_CSC_LINK (base64 .pfx) plus
// WIN_CSC_KEY_PASSWORD. Signing happens during packaging, so latest.yml
// stays consistent with the shipped installer.

function isTruthy(value) {
  return /^(1|true|yes)$/i.test((value || '').trim())
}

function present(key) {
  return Boolean(process.env[key]?.trim())
}

const nativeSigning = present('WIN_CSC_LINK') && present('WIN_CSC_KEY_PASSWORD')
const nativeSigningPartial = present('WIN_CSC_LINK') || present('WIN_CSC_KEY_PASSWORD')
const signPathKeys = [
  'SIGNPATH_API_TOKEN',
  'SIGNPATH_ORGANIZATION_ID',
  'SIGNPATH_PROJECT_SLUG',
].filter(present)

const allowUnsigned = isTruthy(process.env.OPEN_COWORK_ALLOW_UNSIGNED_RELEASES)
const refName = process.env.GITHUB_REF_NAME || ''

if (signPathKeys.length > 0) {
  console.error(
    'SignPath Windows signing is not wired in this release workflow. ' +
    `Remove unsupported SignPath inputs (${signPathKeys.join(', ')}) and configure ` +
    'WIN_CSC_LINK + WIN_CSC_KEY_PASSWORD for signed Windows releases.',
  )
  process.exit(1)
}

if (nativeSigningPartial && !nativeSigning) {
  console.error('Incomplete Windows signing configuration. Provide both WIN_CSC_LINK and WIN_CSC_KEY_PASSWORD.')
  process.exit(1)
}

if (nativeSigning) {
  console.error('Windows release signing is configured (native-certificate); building signed artifacts.')
  process.stdout.write('mode=signed\n')
  process.stdout.write('mechanism=native-certificate\n')
  process.exit(0)
}

if (!allowUnsigned) {
  console.error(
    'Missing Windows signing configuration. Provide WIN_CSC_LINK + WIN_CSC_KEY_PASSWORD ' +
    '(exportable certificate), or explicitly opt into a preview-only unsigned tag release with the ' +
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
