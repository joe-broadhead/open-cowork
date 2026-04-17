// Renderer-side brand singleton. App.tsx fetches the PublicAppConfig
// once at boot (via `app:config` IPC) and seeds this cache so leaf
// components can template the brand name into copy without having to
// receive it as a prop from the top of the tree. Falls back to the
// upstream default until config arrives — which is fine because the
// loading screens show branded copy from the App-level config prop
// anyway.

let cachedBrandName = 'Open Cowork'

export function setBrandName(name: string | null | undefined) {
  if (name && typeof name === 'string' && name.trim().length > 0) {
    cachedBrandName = name.trim()
  }
}

export function getBrandName(): string {
  return cachedBrandName
}
