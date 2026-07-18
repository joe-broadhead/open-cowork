import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("personal transcript inbox dogfood smoke proves inbox to proposals to sync to backup", async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--no-warnings", "--import", "tsx", "scripts/openwiki-personal-inbox-smoke.mjs", "--json"],
    {
      cwd: process.cwd(),
      timeout: 120_000,
      maxBuffer: 1024 * 1024 * 24,
    },
  );
  const evidence = JSON.parse(stdout) as {
    schema_version: string;
    opencode: {
      tool_mode: string;
      transport: string;
      meeting_curator_agent_present: boolean;
      installed_files: string[];
    };
    transcript: {
      source_id: string;
      inbox_item_id: string;
      raw_source_verified: boolean;
      inbox_status_after_process: string;
    };
    meeting_curation: {
      proposal_ids: string[];
      proposal_types: string[];
      required_types_present: boolean;
    };
    review_apply: {
      applied_commit_sha?: string;
      applied_paths: string[];
    };
    sync: {
      status: string;
      remote_head: string;
      clean: boolean;
      ahead: number;
      behind: number;
    };
    backup: {
      verification_status: string;
      rehearsal_status: string;
    };
    product_notes: string[];
    commands: Array<{ command: string; exit_code: number }>;
  };

  assert.equal(evidence.schema_version, "openwiki.personal_inbox_evidence.v1");
  assert.equal(evidence.opencode.tool_mode, "proposal");
  assert.equal(evidence.opencode.transport, "stdio");
  assert.equal(evidence.opencode.meeting_curator_agent_present, true);
  assert.ok(evidence.opencode.installed_files.includes(".opencode/agents/openwiki-meeting-curator.md"));

  assert.match(evidence.transcript.inbox_item_id, /^inbox:/);
  assert.match(evidence.transcript.source_id, /^source:/);
  assert.equal(evidence.transcript.raw_source_verified, true);
  assert.equal(evidence.transcript.inbox_status_after_process, "proposed");

  assert.equal(evidence.meeting_curation.required_types_present, true);
  assert.ok(evidence.meeting_curation.proposal_ids.length >= 4);
  for (const requiredType of ["meeting", "person", "organization", "topic"]) {
    assert.ok(evidence.meeting_curation.proposal_types.includes(requiredType), `missing ${requiredType} proposal`);
  }

  assert.match(evidence.review_apply.applied_commit_sha ?? "", /^[0-9a-f]{7,40}$/);
  assert.ok(evidence.review_apply.applied_paths.some((appliedPath) => appliedPath === "wiki/meetings/acme-launch-sync.md"));
  assert.equal(evidence.sync.status, "synced");
  assert.match(evidence.sync.remote_head, /^[0-9a-f]{40}$/);
  assert.equal(evidence.sync.clean, true);
  assert.equal(evidence.sync.ahead, 0);
  assert.equal(evidence.sync.behind, 0);
  assert.equal(evidence.backup.verification_status, "passed");
  assert.equal(evidence.backup.rehearsal_status, "passed");
  assert.ok(evidence.product_notes.length >= 3);

  assert.ok(evidence.commands.some((entry) => /openwiki setup personal/.test(entry.command)));
  assert.ok(evidence.commands.some((entry) => /openwiki agent install/.test(entry.command)));
  assert.ok(evidence.commands.some((entry) => /openwiki .*inbox watch/.test(entry.command)));
  assert.ok(evidence.commands.some((entry) => /openwiki .*proposal apply/.test(entry.command)));
  assert.ok(evidence.commands.some((entry) => /openwiki .*sync now/.test(entry.command)));
  assert.ok(evidence.commands.some((entry) => /openwiki .*backup rehearse/.test(entry.command)));
  assert.deepEqual(evidence.commands.filter((entry) => entry.exit_code !== 0), []);
  assert.equal(evidence.commands.some((entry) => /\bpnpm\b/.test(entry.command)), false);
});
