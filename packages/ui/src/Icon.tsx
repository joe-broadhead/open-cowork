import type { ComponentPropsWithoutRef } from 'react'
import {
  Activity,
  AlertCircle,
  ArrowDown,
  ArrowUp,
  AtSign,
  BadgeCheck,
  Bell,
  Blocks,
  BookOpen,
  Bot,
  Brain,
  BriefcaseBusiness,
  Camera,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  CircleX,
  Clipboard,
  Columns3,
  Copy,
  ExternalLink,
  File,
  FileDiff,
  FileText,
  Folder,
  GitFork,
  Gauge,
  HeartPulse,
  Home,
  Info,
  ListChecks,
  LoaderCircle,
  Menu,
  MessageSquare,
  Minus,
  Network,
  PanelLeft,
  PanelRightOpen,
  Paperclip,
  Plus,
  Radio,
  RotateCcw,
  Route,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Square,
  SquareKanban,
  Trash2,
  UserRoundCheck,
  Users,
  Waypoints,
  Workflow,
  Wrench,
  Zap,
  X,
  type LucideIcon,
} from 'lucide-react'

const ICONS = {
  activity: Activity,
  'alert-circle': AlertCircle,
  'arrow-down': ArrowDown,
  'arrow-up': ArrowUp,
  'at-sign': AtSign,
  'badge-check': BadgeCheck,
  bell: Bell,
  blocks: Blocks,
  'book-open': BookOpen,
  bot: Bot,
  brain: Brain,
  briefcase: BriefcaseBusiness,
  camera: Camera,
  check: Check,
  'chevron-down': ChevronDown,
  'chevron-left': ChevronLeft,
  'chevron-right': ChevronRight,
  'circle-help': CircleHelp,
  'circle-x': CircleX,
  clipboard: Clipboard,
  columns: Columns3,
  copy: Copy,
  'external-link': ExternalLink,
  file: File,
  'file-diff': FileDiff,
  'file-text': FileText,
  folder: Folder,
  gauge: Gauge,
  'git-fork': GitFork,
  'heart-pulse': HeartPulse,
  home: Home,
  info: Info,
  kanban: SquareKanban,
  'list-checks': ListChecks,
  'loader-circle': LoaderCircle,
  menu: Menu,
  'message-square': MessageSquare,
  minus: Minus,
  network: Network,
  'panel-left': PanelLeft,
  'panel-right-open': PanelRightOpen,
  paperclip: Paperclip,
  plus: Plus,
  radio: Radio,
  'rotate-ccw': RotateCcw,
  route: Route,
  search: Search,
  send: Send,
  'settings-2': Settings2,
  'shield-check': ShieldCheck,
  sliders: SlidersHorizontal,
  sparkles: Sparkles,
  square: Square,
  'trash-2': Trash2,
  'user-round-check': UserRoundCheck,
  users: Users,
  waypoints: Waypoints,
  workflow: Workflow,
  wrench: Wrench,
  zap: Zap,
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

/**
 * Icon system conventions (the graphite operator console):
 *
 * SIZE -> ROLE (three rungs, no arbitrary px):
 *   16 = inline / dense rows / chips / buttons
 *   20 = standalone affordances (toolbar, IconButton default, nav rail)
 *   24 = feature / empty-state / header focal icons only
 *
 * STROKE is size-aware by default so small glyphs hold up on the dark field and
 * large glyphs don't read heavy: 16->1.75, 20->1.5, 24->1.25. Pass `strokeWidth`
 * to override (e.g. an active nav glyph may bump to 1.75 for emphasis).
 *
 * COLOUR STATES (only four): default/decorative = text-text-muted; hover/active
 * foreground = text-text (brightens on the SAME container's hover, never its own
 * timeline); accent = text-accent, reserved for the ONE primary/active/live icon
 * per view (the surgical-accent allow-list); a status-hue glyph is deprecated for
 * status — use the 6px status DOT instead (green/amber/red), reserving coloured
 * glyphs for inline prose alerts only.
 *
 * Prefer a bare glyph; use an icon-TILE (bg + radius) only for a section/category
 * avatar, an empty-state focal icon, or the active nav item.
 */
export function Icon({
  name,
  size = 16,
  strokeWidth,
  'aria-hidden': ariaHidden = true,
  ...props
}: IconProps) {
  const Component = ICONS[name]
  const resolvedStroke = strokeWidth ?? (size >= 24 ? 1.25 : size <= 16 ? 1.75 : 1.5)
  return (
    <Component
      {...props}
      aria-hidden={ariaHidden}
      color="currentColor"
      focusable="false"
      size={size}
      strokeWidth={resolvedStroke}
    />
  )
}
