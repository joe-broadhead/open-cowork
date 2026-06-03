import type { ComponentPropsWithoutRef } from 'react'
import {
  Activity,
  AlertCircle,
  ArrowUp,
  BadgeCheck,
  Bell,
  Blocks,
  Bot,
  Brain,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  CircleX,
  Clipboard,
  Copy,
  ExternalLink,
  File,
  Folder,
  GitFork,
  HeartPulse,
  Home,
  Info,
  LoaderCircle,
  Menu,
  Minus,
  PanelLeft,
  Paperclip,
  Plus,
  Search,
  Settings2,
  Sparkles,
  Square,
  Trash2,
  Users,
  Workflow,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react'

const ICONS = {
  activity: Activity,
  'alert-circle': AlertCircle,
  'arrow-up': ArrowUp,
  'badge-check': BadgeCheck,
  bell: Bell,
  blocks: Blocks,
  bot: Bot,
  brain: Brain,
  check: Check,
  'chevron-down': ChevronDown,
  'chevron-left': ChevronLeft,
  'chevron-right': ChevronRight,
  'circle-help': CircleHelp,
  'circle-x': CircleX,
  clipboard: Clipboard,
  copy: Copy,
  'external-link': ExternalLink,
  file: File,
  folder: Folder,
  'git-fork': GitFork,
  'heart-pulse': HeartPulse,
  home: Home,
  info: Info,
  'loader-circle': LoaderCircle,
  menu: Menu,
  minus: Minus,
  'panel-left': PanelLeft,
  paperclip: Paperclip,
  plus: Plus,
  search: Search,
  'settings-2': Settings2,
  sparkles: Sparkles,
  square: Square,
  'trash-2': Trash2,
  users: Users,
  workflow: Workflow,
  wrench: Wrench,
  x: X,
} satisfies Record<string, LucideIcon>

export type IconName = keyof typeof ICONS
export type IconSize = 16 | 20 | 24

export type IconProps = Omit<ComponentPropsWithoutRef<'svg'>, 'aria-hidden' | 'color' | 'name'> & {
  name: IconName
  size?: IconSize
  strokeWidth?: number
  'aria-hidden'?: boolean | 'true' | 'false'
}

export function Icon({
  name,
  size = 16,
  strokeWidth = 1.5,
  'aria-hidden': ariaHidden = true,
  ...props
}: IconProps) {
  const Component = ICONS[name]
  return (
    <Component
      {...props}
      aria-hidden={ariaHidden}
      color="currentColor"
      focusable="false"
      size={size}
      strokeWidth={strokeWidth}
    />
  )
}
