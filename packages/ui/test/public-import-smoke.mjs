const ui = await import('../dist/index.js')
const appApi = await import('../dist/AppApiProvider.js')
const badge = await import('../dist/Badge.js')
const card = await import('../dist/Card.js')
const primitiveGallery = await import('../dist/PrimitiveGallery.js')

const requiredExports = [
  ['AppApiProvider', ui.AppApiProvider],
  ['Badge', ui.Badge],
  ['Button', ui.Button],
  ['Card', ui.Card],
  ['PrimitiveGallery', ui.PrimitiveGallery],
  ['WorkbenchLayout', ui.WorkbenchLayout],
]

for (const [name, value] of requiredExports) {
  if (value == null) {
    throw new Error(`Expected @open-cowork/ui export ${name} to be present`)
  }
}

if (appApi.AppApiProvider !== ui.AppApiProvider) {
  throw new Error('Expected app-api subpath to match the public AppApiProvider export')
}

if (badge.Badge !== ui.Badge) {
  throw new Error('Expected badge subpath to match the public Badge export')
}

if (card.Card !== ui.Card) {
  throw new Error('Expected card subpath to match the public Card export')
}

if (primitiveGallery.PrimitiveGallery !== ui.PrimitiveGallery) {
  throw new Error('Expected primitive-gallery subpath to match the public PrimitiveGallery export')
}
