const ui = await import('../dist/index.js')
const badge = await import('../dist/Badge.js')
const card = await import('../dist/Card.js')
const primitiveGallery = await import('../dist/PrimitiveGallery.js')
const studio = await import('../dist/StudioPrimitives.js')
const studioSubpath = await import('@open-cowork/ui/studio')

const requiredExports = [
  ['Badge', ui.Badge],
  ['Button', ui.Button],
  ['Card', ui.Card],
  ['PrimitiveGallery', ui.PrimitiveGallery],
  ['StudioShell', ui.StudioShell],
  ['CoworkerCard', ui.CoworkerCard],
  ['ComposerShell', ui.ComposerShell],
  ['TaskLane', ui.TaskLane],
  ['ConversationLaneCard', ui.ConversationLaneCard],
  ['KanbanBoard', ui.KanbanBoard],
  ['RunTimeline', ui.RunTimeline],
  ['PermissionEditorRow', ui.PermissionEditorRow],
  ['DeliverableCard', ui.DeliverableCard],
  ['WizardSteps', ui.WizardSteps],
  ['WikiPage', ui.WikiPage],
  ['WorkbenchLayout', ui.WorkbenchLayout],
]

for (const [name, value] of requiredExports) {
  if (value == null) {
    throw new Error(`Expected @open-cowork/ui export ${name} to be present`)
  }
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

if (studio.StudioShell !== ui.StudioShell) {
  throw new Error('Expected studio subpath to match the public StudioShell export')
}

if (studioSubpath.StudioShell !== ui.StudioShell) {
  throw new Error('Expected package studio subpath to match the public StudioShell export')
}
