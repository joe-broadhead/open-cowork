/**
 * Agent routing table.
 * 
 * Maps incoming messages (from channels) to specific agents.
 * Configured via ~/.config/opencode-gateway/routing.json
 * 
 * Format:
 * {
 *   "default": "gateway-assistant",
 *   "routes": [
 *     { "provider": "telegram", "chatId": "*", "agent": "gateway-assistant" },
 *     { "provider": "whatsapp", "chatId": "*", "agent": "gateway-assistant" },
 *     { "pattern": "status|health|doctor|logs|config|channel", "agent": "gateway-coordinator" },
 *     { "pattern": "plan|roadmap|task|queue|scheduler", "agent": "gateway-planner" }
 *   ]
 * }
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { getConfigDir } from './config.js'

function routingPath(): string {
  return path.join(getConfigDir(), 'routing.json')
}

export interface Route {
  provider?: string
  chatId?: string
  pattern?: string
  agent: string
}

export interface RoutingConfig {
  default: string
  routes: Route[]
}

export const DEFAULT_ROUTING: RoutingConfig = {
  default: 'gateway-assistant',
  routes: [
    { pattern: 'status|health|doctor|logs|config|channel', agent: 'gateway-coordinator' },
    { pattern: 'plan|roadmap|task|queue|scheduler', agent: 'gateway-planner' },
    { pattern: 'implement|fix|build|change', agent: 'gateway-implementer' },
    { pattern: 'review|verify|audit', agent: 'gateway-reviewer' },
  ],
}

export function loadRouting(): RoutingConfig {
  try {
    const raw = fs.readFileSync(routingPath(), 'utf-8')
    return { ...DEFAULT_ROUTING, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULT_ROUTING }
  }
}

export function resolveAgent(
  provider: string,
  chatId: string,
  text: string,
): string {
  const config = loadRouting()
  
  // Exact provider + chatId match
  for (const route of config.routes) {
    if (route.provider && route.chatId) {
      if (route.provider === provider && (route.chatId === '*' || route.chatId === chatId)) {
        return route.agent
      }
    }
  }
  
  // Text pattern match
  for (const route of config.routes) {
    if (route.pattern) {
      try {
        if (new RegExp(route.pattern, 'i').test(text)) {
          return route.agent
        }
      } catch {}
    }
  }
  
  return config.default
}
