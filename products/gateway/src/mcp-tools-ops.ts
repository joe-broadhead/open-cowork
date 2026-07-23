/**
 * Backup / storage / recovery MCP tool registrations (LOC façade split).
 * Leaf relative to mcp.ts — receives (server, runTool, fetchJSON) and registers tools.
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

type RunTool = (fn: () => Promise<string>) => Promise<any>
type FetchJSON = (method: string, path: string, body?: any) => Promise<any>

export function registerMcpOpsTools(server: McpServer, runTool: RunTool, fetchJSON: FetchJSON): void {
  server.tool('backup_create', 'Create a timestamped Gateway state backup. Refuses active runs and starting dispatches unless allowActiveRuns=true is supplied during an operator-controlled maintenance window.', { label: z.string().optional(), retention: z.number().optional(), allowActiveRuns: z.boolean().optional() },
    async (args: { label?: string; retention?: number; allowActiveRuns?: boolean }) => runTool(async () => JSON.stringify(await fetchJSON('POST', '/storage/backups', args), null, 2)))

  server.tool('backup_list', 'List Gateway state backups and verification status.', {},
    async () => runTool(async () => JSON.stringify(await fetchJSON('GET', '/storage/backups'), null, 2)))

  server.tool('backup_verify', 'Verify a Gateway state backup checksum, metadata, and SQLite integrity.', { path: z.string() },
    async (args: { path: string }) => runTool(async () => JSON.stringify(await fetchJSON('POST', '/storage/backups/verify', args), null, 2)))

  server.tool('recovery_drill', 'Restore a backup into an isolated state directory and prove scheduler, storage, and channel recovery behavior. Writes evidence under recovery-drills/.', { path: z.string().optional(), label: z.string().optional(), outputDir: z.string().optional(), retryLimit: z.number().optional() },
    async (args: { path?: string; label?: string; outputDir?: string; retryLimit?: number }) => runTool(async () => JSON.stringify(await fetchJSON('POST', '/storage/recovery-drills', args), null, 2)))

  // Always append localAdmin=true: MCP tool invocation is the operator intent for
  // JOE-952 dual-intent. Without this query the HTTP surface permanently 403s
  // state_export after dual-intent landed (tool has no separate query surface).
  server.tool('state_export', 'Export Gateway durable state as JSON for audit or machine transfer. Requires JOE-952 dual-intent (localAdmin) on the daemon admin surface; this tool supplies localAdmin=true because invoking the tool is the operator intent.', {},
    async () => runTool(async () => JSON.stringify(await fetchJSON('GET', '/storage/export?localAdmin=true'), null, 2)))

  server.tool('restore', 'Restore Gateway state from a verified backup. Requires maintenanceMode=true while daemon is active and destructive-action approval by default. Pass dryRun=true to preview the backup verification and current state that would be replaced without restoring.', { path: z.string(), maintenanceMode: z.boolean().optional(), skipSafetyBackup: z.boolean().optional(), approvedGateId: z.string().optional(), dryRun: z.boolean().optional() },
    async (args: { path: string; maintenanceMode?: boolean; skipSafetyBackup?: boolean; approvedGateId?: string; dryRun?: boolean }) => runTool(async () => JSON.stringify(await fetchJSON('POST', '/storage/restore', args), null, 2)))
}
