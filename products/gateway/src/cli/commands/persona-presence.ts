import { createPersona, listPersonas } from '../../persona.js'
import {
  createAgentPresence,
  getAgentPresence,
  listAgentPresences,
  updateAgentPresence,
} from '../../agent-presence.js'
import { argValue } from '../shared.js'

export async function personaCommand() {
  const sub = process.argv[3] || 'list'
  if (sub === 'create') {
    const name = process.argv[4]
    if (!name) {
      console.error('Usage: opencode-gateway persona create <name> [--description text] [--prompt text] [--model id]')
      process.exit(1)
    }
    const result = createPersona({
      name,
      description: argValue('--description'),
      prompt: argValue('--prompt'),
      model: argValue('--model'),
    })
    console.log(`Persona created as OpenCode primary agent: ${name}`)
    console.log(JSON.stringify(result.agent, null, 2))
    if (result.skill) console.log(`Skill: ${result.skill.path}`)
    return
  }
  if (sub === 'list') {
    const rows = listPersonas()
    console.log(`${rows.length} persona/agent(s)`)
    for (const row of rows) {
      console.log(`- ${row.name}${row.mode ? ` [${row.mode}]` : ''}${row.description ? ` — ${row.description}` : ''}`)
    }
    return
  }
  console.error('Usage: opencode-gateway persona <create|list> ...')
  process.exit(1)
}

export async function presenceCommand() {
  const sub = process.argv[3] || 'list'
  if (sub === 'list') {
    const rows = listAgentPresences({ includeArchived: true })
    console.log(`${rows.length} agent presence(s)`)
    for (const row of rows) {
      console.log(`- ${row.presenceId} [${row.status}] ${row.name} agent=${row.opencodeAgent} session=${row.sessionId || '-'} channel=${row.provider || '-'}:${row.chatId || '-'}`)
    }
    return
  }
  if (sub === 'create') {
    const name = argValue('--name') || process.argv[4]
    const agent = argValue('--agent')
    if (!name || !agent) {
      console.error('Usage: opencode-gateway presence create --name <label> --agent <opencode-agent> [--session id] [--provider x --chat-id y]')
      process.exit(1)
    }
    const row = createAgentPresence({
      name,
      opencodeAgent: agent,
      sessionId: argValue('--session'),
      directory: argValue('--directory'),
      profile: argValue('--profile'),
      provider: argValue('--provider'),
      chatId: argValue('--chat-id'),
      threadId: argValue('--thread-id'),
      note: argValue('--note'),
    })
    console.log(`AgentPresence created: ${row.presenceId}`)
    console.log(JSON.stringify(row, null, 2))
    return
  }
  if (sub === 'get') {
    const id = process.argv[4]
    if (!id) {
      console.error('Usage: opencode-gateway presence get <presenceId>')
      process.exit(1)
    }
    const row = getAgentPresence(id)
    if (!row) {
      console.error(`AgentPresence not found: ${id}`)
      process.exit(1)
    }
    console.log(JSON.stringify(row, null, 2))
    return
  }
  if (sub === 'pause' || sub === 'resume' || sub === 'archive') {
    const id = process.argv[4]
    if (!id) {
      console.error(`Usage: opencode-gateway presence ${sub} <presenceId>`)
      process.exit(1)
    }
    const status = sub === 'pause' ? 'paused' : sub === 'resume' ? 'active' : 'archived'
    const row = updateAgentPresence(id, { status })
    if (!row) {
      console.error(`AgentPresence not found: ${id}`)
      process.exit(1)
    }
    console.log(`AgentPresence ${sub}: ${row.presenceId} -> ${row.status}`)
    return
  }
  if (sub === 'bind-channel') {
    const id = process.argv[4]
    const provider = argValue('--provider')
    const chatId = argValue('--chat-id')
    if (!id || !provider || !chatId) {
      console.error('Usage: opencode-gateway presence bind-channel <presenceId> --provider telegram --chat-id <id> [--thread-id id]')
      process.exit(1)
    }
    const row = updateAgentPresence(id, { provider, chatId, threadId: argValue('--thread-id') || null, status: 'active' })
    if (!row) {
      console.error(`AgentPresence not found: ${id}`)
      process.exit(1)
    }
    console.log(`AgentPresence bound: ${row.presenceId} -> ${row.provider}:${row.chatId}`)
    return
  }
  console.error('Usage: opencode-gateway presence <list|create|get|pause|resume|archive|bind-channel> ...')
  process.exit(1)
}
