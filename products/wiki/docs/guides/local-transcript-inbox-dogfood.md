# Local Transcript Inbox Dogfood

This guide is the local dogfood path for a personal OpenWiki managed by an
agent. It keeps the live wiki on local disk, watches a generic transcript inbox
folder, asks an OpenCode meeting curator to propose wiki changes through stdio
MCP, then lets a human review/apply and sync the result to a private Git
remote.

Provider-specific importers are intentionally out of scope for the shipped
repository. Downstream users can normalize files from recording tools, note
apps, CRMs, or webhooks into this watched folder and tag them with
`--provider source-name`.

## Prerequisites

- Node.js 22.22.3 or newer.
- Git with access to a private repository for this wiki.
- OpenCode installed and able to run local project agents.
- The packaged `openwiki` binary on your `PATH`.

Keep the live workspace out of Google Drive, iCloud Drive, Dropbox, and
OneDrive. Use cloud sync only for backup folders or Git remotes, not for the
active Git working tree.

## Target Paths

```sh
mkdir -p ~/OpenWiki ~/OpenWiki/"Transcript Inbox" ~/OpenWiki/backups
```

Recommended paths:

| Purpose | Path |
| --- | --- |
| Live wiki | `~/OpenWiki/personal-wiki` |
| Transcript inbox | `~/OpenWiki/Transcript Inbox` |
| Local backups | `~/OpenWiki/backups` |
| Private Git remote | User-provided private repository |

## Create The Personal Wiki

Replace the remote URL with your private repository.

```sh
openwiki setup personal ~/OpenWiki/personal-wiki \
  --title "Personal Wiki" \
  --agent opencode \
  --tools proposal \
  --git-remote git@github.com:you/personal-wiki.git \
  --branch main \
  --backup-path ~/OpenWiki/backups \
  --config-out ~/OpenWiki/personal-wiki/opencode.openwiki.json \
  --json
```

This creates a personal wiki, configures stdio MCP in proposal mode, connects
Git sync, configures the local backup destination, writes an OpenCode MCP
config, and installs the project-local `.opencode` personal-curator pack.
Use `openwiki agent install --provider opencode ...` later only when installing
the pack into another project or refreshing an existing project config.

Run OpenCode from the wiki root so it picks up the project config and
`.opencode` pack:

```sh
cd ~/OpenWiki/personal-wiki
opencode run --agent openwiki-meeting-curator \
  "Use OpenWiki MCP in proposal mode. Process meeting transcript inbox items, search existing people, organizations, projects, and topics first, then propose linked meeting knowledge updates. Do not edit files directly."
```

## Enable Automation

Enable sync metadata and install local user services. On macOS these install
LaunchAgents; on Linux they install user-level systemd units.

```sh
openwiki --root ~/OpenWiki/personal-wiki sync enable \
  --every 15m \
  --pull-on-start \
  --json

openwiki --root ~/OpenWiki/personal-wiki service install sync \
  --every 15m \
  --push \
  --json

openwiki --root ~/OpenWiki/personal-wiki service install backup \
  --every 24h \
  --json

openwiki --root ~/OpenWiki/personal-wiki service install inbox \
  --every 5m \
  --dir ~/OpenWiki/"Transcript Inbox" \
  --adapter file \
  --provider transcript_file \
  --source-type meeting_transcript \
  --actor actor:user:local \
  --json
```

Create the first remote commit after setup:

```sh
openwiki --root ~/OpenWiki/personal-wiki sync now \
  --push \
  --message "Initialize personal wiki" \
  --json
```

## Process A Transcript

Drop a `.txt`, `.md`, or `.json` transcript into:

```sh
~/OpenWiki/Transcript Inbox
```

For a one-off run before relying on the service:

```sh
openwiki --root ~/OpenWiki/personal-wiki inbox watch \
  --dir ~/OpenWiki/"Transcript Inbox" \
  --adapter file \
  --provider transcript_file \
  --source-type meeting_transcript \
  --actor actor:user:local \
  --once \
  --json

openwiki --root ~/OpenWiki/personal-wiki inbox list \
  --status received \
  --source-type meeting_transcript \
  --actor actor:user:local \
  --json
```

Then let the OpenCode meeting curator process the inbox item through MCP. The
agent should call inbox tools, process the transcript into a source, search for
existing entities, and create proposals. It must not edit files directly.

```sh
cd ~/OpenWiki/personal-wiki
opencode run --agent openwiki-meeting-curator \
  "Use OpenWiki MCP. Process the newest received meeting transcript for actor:user:local. Create proposals for the meeting, people, organizations, projects, topics, decisions, and actions. Preserve unknown due dates as open questions."
```

Review the generated proposals:

```sh
openwiki --root ~/OpenWiki/personal-wiki proposal list --status open --json
openwiki --root ~/OpenWiki/personal-wiki proposal detail proposal:YYYY-MM-DD-NNN --json
openwiki --root ~/OpenWiki/personal-wiki proposal review proposal:YYYY-MM-DD-NNN \
  --decision accepted \
  --rationale "Transcript facts are source-linked and uncertainty is preserved." \
  --actor actor:user:local \
  --json
openwiki --root ~/OpenWiki/personal-wiki proposal apply proposal:YYYY-MM-DD-NNN \
  --commit \
  --message "Apply transcript meeting proposal" \
  --actor actor:user:local \
  --json
```

Sync and verify:

```sh
openwiki --root ~/OpenWiki/personal-wiki sync now \
  --push \
  --message "Sync transcript meeting updates" \
  --json

openwiki --root ~/OpenWiki/personal-wiki sync status --json
```

## Backup Rehearsal

Create, verify, and rehearse a restore before trusting the setup:

```sh
openwiki --root ~/OpenWiki/personal-wiki backup create \
  --destination local-backups \
  --verify \
  --json

openwiki --root ~/OpenWiki/personal-wiki backup verify latest \
  --destination local-backups \
  --json

openwiki --root ~/OpenWiki/personal-wiki backup rehearse latest \
  --target-root ~/OpenWiki/restore-rehearsal \
  --destination local-backups \
  --force \
  --json
```

## Repeatable Smoke Evidence

Maintainers can run the deterministic smoke without a live model or private
GitHub repository. It uses a local bare Git remote as a stand-in, writes a
synthetic transcript to an external inbox folder, creates meeting proposals
through OpenWiki commands, applies one proposal, pushes the result, and
rehearses restore.

```sh
node --no-warnings --import tsx scripts/openwiki-personal-inbox-smoke.mjs \
  --json \
  --evidence-out artifacts/personal-inbox-evidence.json
```

The evidence JSON captures:

- generated OpenCode config path;
- transcript inbox item ID and source ID;
- meeting/person/organization/topic proposal IDs;
- applied commit SHA;
- sync status and remote head;
- backup verification and restore rehearsal result;
- at least three product notes for follow-up dogfood.

The fixture is intentionally committed at
`fixtures/transcripts/acme-launch-sync.txt`.
