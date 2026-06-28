export function isOpaqueMessageOrigin(origin: string) {
  return origin === 'null' || origin === 'file://'
}

function isConcreteTargetOrigin(origin: string) {
  return Boolean(origin && !isOpaqueMessageOrigin(origin))
}

export function resolveParentTargetOrigin(referrer: string) {
  try {
    if (referrer) {
      const origin = new URL(referrer).origin
      if (isConcreteTargetOrigin(origin)) return origin
    }
  } catch {
    // Invalid or stripped referrers fall through to the opaque-frame path.
  }

  return '*'
}
