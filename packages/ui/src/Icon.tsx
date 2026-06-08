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
