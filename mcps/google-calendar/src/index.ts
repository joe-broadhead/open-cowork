import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve, dirname } from 'node:path'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'

const execFileAsync = promisify(execFile)

function findGwsBinary(): string {
  if (process.env.GWS_BIN) return process.env.GWS_BIN
  try {
    const require = createRequire(import.meta.url)
    const pkgPath = require.resolve('@googleworkspace/cli/package.json')
    const binPath = resolve(dirname(pkgPath), 'bin', 'gws')
    if (existsSync(binPath)) return binPath
  } catch {}
  return 'gws'
}

const GWS = findGwsBinary()

async function gws(args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(GWS, args, {
      timeout: 60_000, maxBuffer: 50 * 1024 * 1024,
      env: process.env,
    })
    if (stderr) console.error('[gws]', stderr)
    return stdout
  } catch (err: any) {
    throw new Error(`gws failed: ${err.message}\n${err.stderr || ''}`)
  }
}

const server = new McpServer({
  name: 'google-calendar',
  version: '1.0.0',
})

// ─── LIST EVENTS ───

server.tool(
  'list_events',
  'List upcoming events from a calendar.',
  {
    calendarId: z.string().default('primary').describe('Calendar ID (use "primary" for the main calendar)'),
    timeMin: z.string().optional().describe('Lower bound (RFC3339 timestamp, e.g. "2024-01-01T00:00:00Z")'),
    timeMax: z.string().optional().describe('Upper bound (RFC3339 timestamp)'),
    maxResults: z.number().default(10).describe('Maximum number of events to return'),
    singleEvents: z.boolean().default(true).describe('Expand recurring events into instances'),
    orderBy: z.enum(['startTime', 'updated']).default('startTime').describe('Sort order (startTime requires singleEvents=true)'),
    q: z.string().optional().describe('Free text search query'),
    pageToken: z.string().optional().describe('Page token from a previous request'),
  },
  async ({ calendarId, timeMin, timeMax, maxResults, singleEvents, orderBy, q, pageToken }) => {
    const params: Record<string, unknown> = { calendarId, maxResults, singleEvents, orderBy }
    if (timeMin) params.timeMin = timeMin
    if (timeMax) params.timeMax = timeMax
    if (q) params.q = q
    if (pageToken) params.pageToken = pageToken
    const result = await gws(['calendar', 'events', 'list', '--params', JSON.stringify(params)])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── GET EVENT ───

server.tool(
  'get_event',
  'Get full details of a specific calendar event.',
  {
    calendarId: z.string().default('primary').describe('Calendar ID'),
    eventId: z.string().describe('The event ID'),
  },
  async ({ calendarId, eventId }) => {
    const result = await gws(['calendar', 'events', 'get', '--params', JSON.stringify({ calendarId, eventId })])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── CREATE EVENT ───

server.tool(
  'create_event',
  'Create a new calendar event.',
  {
    calendarId: z.string().default('primary').describe('Calendar ID'),
    summary: z.string().describe('Event title'),
    description: z.string().optional().describe('Event description'),
    location: z.string().optional().describe('Event location'),
    startDateTime: z.string().optional().describe('Start date-time (RFC3339, e.g. "2024-06-15T10:00:00-07:00")'),
    endDateTime: z.string().optional().describe('End date-time (RFC3339)'),
    startDate: z.string().optional().describe('Start date for all-day events (YYYY-MM-DD)'),
    endDate: z.string().optional().describe('End date for all-day events (YYYY-MM-DD, exclusive)'),
    timeZone: z.string().optional().describe('Time zone (e.g. "America/Los_Angeles")'),
    attendees: z.array(z.string()).optional().describe('List of attendee email addresses'),
    recurrence: z.array(z.string()).optional().describe('Recurrence rules (e.g. ["RRULE:FREQ=WEEKLY;COUNT=5"])'),
  },
  async ({ calendarId, summary, description, location, startDateTime, endDateTime, startDate, endDate, timeZone, attendees, recurrence }) => {
    const body: Record<string, unknown> = { summary }
    if (description) body.description = description
    if (location) body.location = location
    if (startDateTime) {
      body.start = { dateTime: startDateTime, ...(timeZone ? { timeZone } : {}) }
      body.end = { dateTime: endDateTime || startDateTime, ...(timeZone ? { timeZone } : {}) }
    } else if (startDate) {
      body.start = { date: startDate }
      body.end = { date: endDate || startDate }
    } else {
      throw new Error('Either startDateTime or startDate is required')
    }
    if (attendees) body.attendees = attendees.map(email => ({ email }))
    if (recurrence) body.recurrence = recurrence
    const result = await gws([
      'calendar', 'events', 'insert',
      '--params', JSON.stringify({ calendarId }),
      '--json', JSON.stringify(body),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── QUICK ADD ───

server.tool(
  'quick_add',
  'Quickly create an event from a natural language text string (e.g. "Meeting tomorrow at 3pm").',
  {
    calendarId: z.string().default('primary').describe('Calendar ID'),
    text: z.string().describe('Natural language event description (e.g. "Lunch with Alice tomorrow at noon")'),
  },
  async ({ calendarId, text }) => {
    const result = await gws(['calendar', 'events', 'quickAdd', '--params', JSON.stringify({ calendarId, text })])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── UPDATE EVENT ───

server.tool(
  'update_event',
  'Update an existing calendar event. Only provided fields will be changed.',
  {
    calendarId: z.string().default('primary').describe('Calendar ID'),
    eventId: z.string().describe('The event ID to update'),
    summary: z.string().optional().describe('Updated event title'),
    description: z.string().optional().describe('Updated description'),
    location: z.string().optional().describe('Updated location'),
    startDateTime: z.string().optional().describe('Updated start date-time (RFC3339)'),
    endDateTime: z.string().optional().describe('Updated end date-time (RFC3339)'),
    startDate: z.string().optional().describe('Updated start date for all-day events (YYYY-MM-DD)'),
    endDate: z.string().optional().describe('Updated end date for all-day events (YYYY-MM-DD)'),
    timeZone: z.string().optional().describe('Time zone'),
    attendees: z.array(z.string()).optional().describe('Updated attendee email list (replaces existing)'),
    status: z.enum(['confirmed', 'tentative', 'cancelled']).optional().describe('Event status'),
  },
  async ({ calendarId, eventId, summary, description, location, startDateTime, endDateTime, startDate, endDate, timeZone, attendees, status }) => {
    const body: Record<string, unknown> = {}
    if (summary) body.summary = summary
    if (description !== undefined) body.description = description
    if (location !== undefined) body.location = location
    if (startDateTime) {
      body.start = { dateTime: startDateTime, ...(timeZone ? { timeZone } : {}) }
      if (endDateTime) body.end = { dateTime: endDateTime, ...(timeZone ? { timeZone } : {}) }
    } else if (startDate) {
      body.start = { date: startDate }
      if (endDate) body.end = { date: endDate }
    }
    if (attendees) body.attendees = attendees.map(email => ({ email }))
    if (status) body.status = status
    if (Object.keys(body).length === 0) throw new Error('At least one field to update is required')
    const result = await gws([
      'calendar', 'events', 'patch',
      '--params', JSON.stringify({ calendarId, eventId }),
      '--json', JSON.stringify(body),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── DELETE EVENT ───

server.tool(
  'delete_event',
  'Delete a calendar event.',
  {
    calendarId: z.string().default('primary').describe('Calendar ID'),
    eventId: z.string().describe('The event ID to delete'),
  },
  async ({ calendarId, eventId }) => {
    const result = await gws(['calendar', 'events', 'delete', '--params', JSON.stringify({ calendarId, eventId })])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── LIST CALENDARS ───

server.tool(
  'list_calendars',
  'List all calendars the user has access to.',
  {
    pageToken: z.string().optional().describe('Page token from a previous request'),
  },
  async ({ pageToken }) => {
    const args = ['calendar', 'calendarList', 'list']
    if (pageToken) args.push('--params', JSON.stringify({ pageToken }))
    const result = await gws(args)
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── FREEBUSY ───

server.tool(
  'freebusy',
  'Check free/busy availability for one or more calendars in a time range.',
  {
    timeMin: z.string().describe('Start of the time range (RFC3339 timestamp)'),
    timeMax: z.string().describe('End of the time range (RFC3339 timestamp)'),
    calendarIds: z.array(z.string()).default(['primary']).describe('Calendar IDs to check (defaults to primary)'),
    timeZone: z.string().optional().describe('Time zone for the query'),
  },
  async ({ timeMin, timeMax, calendarIds, timeZone }) => {
    const body: Record<string, unknown> = {
      timeMin,
      timeMax,
      items: calendarIds.map(id => ({ id })),
    }
    if (timeZone) body.timeZone = timeZone
    const result = await gws(['calendar', 'freebusy', 'query', '--json', JSON.stringify(body)])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── SCHEMA ───

const DISCOVERY_URL = 'https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest'
let cachedDiscovery: any = null

async function getDiscovery(): Promise<any> {
  if (cachedDiscovery) return cachedDiscovery
  const res = await fetch(DISCOVERY_URL)
  if (!res.ok) throw new Error(`Discovery Service returned ${res.status}: ${res.statusText}`)
  cachedDiscovery = await res.json()
  return cachedDiscovery
}

function resolveRef(schemas: any, ref: string, depth = 0): any {
  if (depth > 5) return { type: 'object', description: `(see ${ref})` }
  const schema = schemas[ref]
  if (!schema) return { type: 'unknown' }
  const result: any = { description: schema.description }
  if (schema.properties) {
    result.properties = {}
    for (const [key, val] of Object.entries(schema.properties) as any) {
      if (val.$ref) {
        result.properties[key] = resolveRef(schemas, val.$ref, depth + 1)
      } else if (val.items?.$ref) {
        result.properties[key] = { type: 'array', description: val.description, items: resolveRef(schemas, val.items.$ref, depth + 1) }
      } else {
        result.properties[key] = { type: val.type || val.enum?.join('|') || 'any', description: val.description }
        if (val.enum) result.properties[key].enum = val.enum
      }
    }
  }
  if (schema.enum) result.enum = schema.enum
  return result
}

server.tool(
  'schema',
  'Look up the Google Calendar API schema from the live Discovery Service. Browse available resources and data types.',
  {
    resource: z.string().optional().describe('Resource/schema name to look up (e.g. "Event", "Calendar", "FreeBusyResponse"). Leave empty to list all available schemas.'),
  },
  async ({ resource }) => {
    try {
      const discovery = await getDiscovery()
      const schemas = discovery.schemas || {}

      if (!resource) {
        const types = Object.entries(schemas).map(([name, val]: [string, any]) => {
          return `- **${name}**: ${val.description || ''}`
        })
        return { content: [{ type: 'text' as const, text: `# Available Calendar API schemas (${types.length})\n\n${types.join('\n')}` }] }
      }

      let schema = schemas[resource]
      if (!schema) {
        const key = Object.keys(schemas).find(k => k.toLowerCase() === resource.toLowerCase())
        if (key) schema = schemas[key]
      }

      if (!schema) {
        const matches = Object.keys(schemas).filter(k => k.toLowerCase().includes(resource.toLowerCase()))
        if (matches.length) {
          return { content: [{ type: 'text' as const, text: `"${resource}" not found. Did you mean:\n${matches.map(m => `- ${m}`).join('\n')}` }] }
        }
        return { content: [{ type: 'text' as const, text: `"${resource}" not found. Call schema() to list all types.` }] }
      }

      const resolved = resolveRef(schemas, resource)
      return { content: [{ type: 'text' as const, text: `# ${resource}\n\n${resolved.description || ''}\n\n## Structure\n\n\`\`\`json\n${JSON.stringify(resolved.properties || {}, null, 2)}\n\`\`\`` }] }
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: `Failed to fetch schema: ${err.message}` }] }
    }
  },
)

// ─── MOVE EVENT ───

server.tool(
  'move_event',
  'Move an event to a different calendar.',
  {
    calendarId: z.string().default('primary'),
    eventId: z.string().describe('The event ID'),
    destination: z.string().describe('Target calendar ID'),
  },
  async ({ calendarId, eventId, destination }) => {
    const result = await gws(['calendar', 'events', 'move', '--params', JSON.stringify({ calendarId, eventId, destination })])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── LIST EVENT INSTANCES ───

server.tool(
  'list_event_instances',
  'List instances of a recurring event.',
  {
    calendarId: z.string().default('primary'),
    eventId: z.string().describe('The recurring event ID'),
    maxResults: z.number().default(10),
  },
  async ({ calendarId, eventId, maxResults }) => {
    const result = await gws(['calendar', 'events', 'instances', '--params', JSON.stringify({ calendarId, eventId, maxResults })])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── CREATE CALENDAR ───

server.tool(
  'create_calendar',
  'Create a new secondary calendar.',
  {
    summary: z.string().describe('Calendar name'),
    description: z.string().optional(),
    timeZone: z.string().optional().describe('IANA timezone (e.g. "Europe/Paris")'),
  },
  async ({ summary, description, timeZone }) => {
    const body: Record<string, unknown> = { summary }
    if (description) body.description = description
    if (timeZone) body.timeZone = timeZone
    const result = await gws(['calendar', 'calendars', 'insert', '--json', JSON.stringify(body)])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── DELETE CALENDAR ───

server.tool(
  'delete_calendar',
  'Delete a secondary calendar. Cannot delete the primary calendar.',
  { calendarId: z.string().describe('The calendar ID to delete') },
  async ({ calendarId }) => {
    const result = await gws(['calendar', 'calendars', 'delete', '--params', JSON.stringify({ calendarId })])
    return { content: [{ type: 'text' as const, text: result || 'Calendar deleted' }] }
  },
)

// ─── GET COLORS ───

server.tool(
  'get_colors',
  'Get available calendar and event color definitions.',
  {},
  async () => {
    const result = await gws(['calendar', 'colors', 'get'])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── ADD ATTENDEE ───

server.tool(
  'add_attendee',
  'Add an attendee to an existing event. Fetches the event, appends the attendee, and updates it.',
  {
    calendarId: z.string().default('primary'),
    eventId: z.string().describe('The event ID'),
    email: z.string().describe('Attendee email address'),
  },
  async ({ calendarId, eventId, email }) => {
    const eventJson = await gws(['calendar', 'events', 'get', '--params', JSON.stringify({ calendarId, eventId })])
    let attendees: Array<{ email: string }> = []
    try {
      const event = JSON.parse(eventJson)
      attendees = event.attendees || []
    } catch {}
    attendees.push({ email })
    const result = await gws([
      'calendar', 'events', 'patch',
      '--params', JSON.stringify({ calendarId, eventId }),
      '--json', JSON.stringify({ attendees }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── CUSTOM API CALL ───

server.tool(
  'run_api_call',
  'Run a custom gws calendar API call for operations not covered by other tools.',
  {
    args: z.array(z.string()).describe('gws command arguments after "calendar", e.g. ["events", "list", "--params", "{}"]'),
  },
  async ({ args }) => {
    const result = await gws(['calendar', ...args])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// Start
async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('[google-calendar-mcp] Server started')
}
main().catch((err) => { console.error('[google-calendar-mcp] Fatal:', err); process.exit(1) })
