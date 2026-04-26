export interface MentionableAgent {
  id: string
  label: string
  description: string
}

export type InlinePickerState = {
  trigger: '@'
  query: string
  start: number
  end: number
  selectedIndex: number
}

export interface Attachment {
  mime: string
  url: string
  filename: string
  preview?: string
}
