const requiredSigningEnv = [
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID',
]

function isTruthy(value) {
  return /^(1|true|yes)$/i.test((value || '').trim())
}

const missing = requiredSigningEnv.filter((key) => !process.env[key]?.trim())
const allowUnsigned = isTruthy(process.env.OPEN_COWORK_ALLOW_UNSIGNED_RELEASES)
const refName = process.env.GITHUB_REF_NAME || ''

if (missing.length === 0) {
  console.error('macOS release signing is configured; building signed artifacts.')
  process.stdout.write('mode=signed\n')
  process.exit(0)
}

if (!allowUnsigned) {
  console.error(
    `Missing required macOS signing environment: ${missing.join(', ')}. ` +
    'Set the signing/notarization secrets, or explicitly opt into a preview-only unsigned tag release ' +
    'with the OPEN_COWORK_ALLOW_UNSIGNED_RELEASES repository variable.',
  )
  process.exit(1)
}

if (!/^v0\./.test(refName)) {
  console.error(
    `OPEN_COWORK_ALLOW_UNSIGNED_RELEASES is only valid for v0.x preview tags. ` +
    `Ref ${refName || '(unknown)'} must be signed/notarized.`,
  )
  process.exit(1)
}

console.error(
  'OPEN_COWORK_ALLOW_UNSIGNED_RELEASES is enabled; building unsigned preview artifacts. ' +
  'This should not be used for public production releases.',
)
process.stdout.write('mode=unsigned\n')
