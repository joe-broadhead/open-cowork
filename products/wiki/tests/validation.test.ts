import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import type { OpenWikiConfig, OpenWikiPolicyBundle } from "@openwiki/core";
import { validateGitBranchName } from "@openwiki/git";
import { createWorkspace } from "@openwiki/repo";
import { validateOpenWikiConfig, validatePolicyBundle, validateRepository } from "@openwiki/validation";
import { submitInboxItem } from "@openwiki/workflows";

const claimIndexPath = (root: string): string => path.join(root, "claims", "claim-index.jsonl");

function issueCodes(issues: { code: string }[]): string[] {
  return issues.map((issue) => issue.code);
}

test("validateRepository passes a freshly created workspace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-validation-ok-"));
  try {
    await createWorkspace(root, "Validation Wiki");
    const report = await validateRepository(root);
    assert.equal(report.status, "passed");
    assert.equal(report.issues.some((issue) => issue.severity === "error"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validateRepository flags claims referencing missing pages and sources", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-validation-refs-"));
  try {
    await createWorkspace(root, "Validation Wiki");
    const danglingClaim = {
      id: "claim:dangling-001",
      uri: "openwiki://claim/dangling-001",
      type: "claim",
      text: "A claim with no backing page or source.",
      page_id: "page:does-not-exist",
      source_ids: ["source:does-not-exist"],
      confidence: "medium",
      risk: "low",
      last_verified_at: "2026-05-21T10:00:00.000Z",
      status: "active",
    };
    await appendFile(claimIndexPath(root), JSON.stringify(danglingClaim) + "\n");

    const report = await validateRepository(root);
    assert.equal(report.status, "failed");
    const codes = issueCodes(report.issues);
    assert.ok(codes.includes("claim.page.missing"), `expected claim.page.missing, saw ${codes.join(",")}`);
    assert.ok(codes.includes("claim.source.missing"), `expected claim.source.missing, saw ${codes.join(",")}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validateRepository flags duplicate record ids", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-validation-dupe-"));
  try {
    await createWorkspace(root, "Validation Wiki");
    // Re-append the seeded claim id so it appears twice.
    const duplicate = {
      id: "claim:2026-05-21-001",
      uri: "openwiki://claim/2026-05-21-001",
      type: "claim",
      text: "Duplicate id on a second line.",
      page_id: "page:concept:agent-memory",
      source_ids: ["source:2026-05-21-001"],
      confidence: "medium",
      risk: "low",
      last_verified_at: "2026-05-21T10:00:00.000Z",
      status: "active",
    };
    await appendFile(claimIndexPath(root), JSON.stringify(duplicate) + "\n");

    const report = await validateRepository(root);
    assert.equal(report.status, "failed");
    assert.ok(issueCodes(report.issues).includes("record.id.duplicate"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validateRepository allows operational artifact event references without record warnings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-validation-operational-events-"));
  try {
    await createWorkspace(root, "Validation Wiki");
    await appendFile(
      path.join(root, "events", "events.jsonl"),
      [
        JSON.stringify({
          id: "event:operational-artifact",
          uri: "openwiki://event/operational-artifact",
          type: "backup.created",
          workspace_id: "workspace:validation-wiki",
          actor_id: "actor:user:local",
          operation: "wiki.backup_create",
          record_id: "openwiki-backup-workspace-validation-wiki-2026-06-02T00-00-00-000Z",
          record_type: "backup",
          occurred_at: "2026-06-02T00:00:00.000Z",
        }),
        JSON.stringify({
          id: "event:missing-record",
          uri: "openwiki://event/missing-record",
          type: "custom.event",
          workspace_id: "workspace:validation-wiki",
          actor_id: "actor:user:local",
          operation: "wiki.custom",
          record_id: "missing:record",
          record_type: "custom",
          occurred_at: "2026-06-02T00:00:01.000Z",
        }),
      ].join("\n") + "\n",
    );

    const report = await validateRepository(root);
    const missingRecordMessages = report.issues
      .filter((issue) => issue.code === "event.record.missing")
      .map((issue) => issue.message);
    assert.equal(missingRecordMessages.some((message) => message.includes("openwiki-backup-workspace-validation-wiki")), false);
    assert.equal(missingRecordMessages.some((message) => message.includes("missing:record")), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validateRepository recognizes inbox event record references", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-validation-inbox-events-"));
  try {
    await createWorkspace(root, "Validation Inbox Wiki");
    const submitted = await submitInboxItem({
      root,
      title: "Validation inbox item",
      content: "Inbox records referenced by events should validate.",
      ownerActorId: "actor:user:joe",
      submittedBy: "actor:user:joe",
    });

    const report = await validateRepository(root);
    const missingRecordMessages = report.issues
      .filter((issue) => issue.code === "event.record.missing")
      .map((issue) => issue.message);
    assert.equal(
      missingRecordMessages.some((message) => message.includes(submitted.item.id)),
      false,
      `expected no missing-record warning for ${submitted.item.id}, saw ${missingRecordMessages.join("; ")}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validateOpenWikiConfig accepts absent and well-formed backup/sync config", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-validation-config-ok-"));
  try {
    const config = await createWorkspace(root, "Validation Config Wiki");
    assert.deepEqual(validateOpenWikiConfig(config, { root }), []);

    const configured: OpenWikiConfig = {
      ...config,
      runtime: {
        ...config.runtime,
        sync: {
          remote: "origin",
          branch: "main",
          mode: "manual",
          pull_on_start: false,
          push_after_commit: false,
          sync_after_events: ["proposal.applied", "inbox.processed"],
          debounce_seconds: 30,
          max_attempts: 3,
          backoff_seconds: 300,
          interval_seconds: 900,
          conflict_policy: "stop",
        },
        queue: {
          backend: "postgres",
          poll_ms: 1000,
          max_jobs_per_worker: 1,
        },
        storage: {
          backend: "minio",
          endpoint_url: "https://minio.example",
          bucket: "openwiki-captures",
          region: "us-east-1",
          prefix: "wiki",
        },
        backups: {
          enabled: true,
          schedule: "manual",
          backup_after_events: ["proposal.applied"],
          event_threshold: 2,
          min_interval_seconds: 3600,
          default_destination_id: "local",
          retention: { keep_last: 20, keep_days: 90 },
          destinations: [
            {
              id: "local",
              kind: "local",
              path: path.join(root, "..", "openwiki-backups"),
            },
            {
              id: "aws",
              kind: "s3",
              bucket: "openwiki-backups",
              prefix: "personal",
              region: "us-east-1",
              access_key_id_env: "AWS_ACCESS_KEY_ID",
              secret_access_key_env: "AWS_SECRET_ACCESS_KEY",
            },
          ],
        },
      },
    };
    assert.deepEqual(validateOpenWikiConfig(configured, { root }), []);

    const reservedRuntimeBackends = {
      ...config,
      runtime: {
        ...config.runtime,
        queue: { backend: "redis" },
        storage: { backend: "gcs" },
      },
    } as unknown as OpenWikiConfig;
    assert.deepEqual(
      issueCodes(validateOpenWikiConfig(reservedRuntimeBackends, { root })),
      ["config.queue.backend.invalid", "config.storage.backend.invalid"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validateRepository reports actionable backup and sync config errors", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-validation-config-bad-"));
  try {
    await createWorkspace(root, "Validation Config Bad Wiki");
    const configPath = path.join(root, "openwiki.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown> & {
      runtime?: Record<string, unknown>;
    };
    config.runtime = {
      ...config.runtime,
      profile: "hosted-postgres",
      queue: {
        backend: "file",
        poll_ms: -1,
        max_jobs_per_worker: 0,
      },
      storage: {
        backend: "disk",
        inline_max_bytes: -1,
        force_path_style: "yes",
      },
      connectors: {
        http: [{ id: "", allowed_hosts: [] }],
        github: [{ id: "gh", allowed_repositories: [] }],
      },
      secrets: {
        backend: "plaintext",
      },
      git: {
        remote: "-origin",
        branch: "bad..branch",
        remote_url: "https://user:secret@example.com/org/wiki.git",
      },
      controls: {
        rate_limits: {
          enabled: "yes",
          window_ms: 1,
          default_limit: -1,
        },
        source_fetch: {
          max_bytes: 0,
        },
        operational_state: {
          backend: "sqlite",
        },
      },
      sync: {
        remote: "-origin",
        branch: "bad..branch",
        mode: "always",
        sync_after_events: ["bad.event"],
        debounce_seconds: -1,
        max_attempts: 0,
        backoff_seconds: -10,
        interval_seconds: 10,
        conflict_policy: "overwrite",
      },
      backups: {
        enabled: true,
        schedule: "often",
        backup_after_events: ["bad.event"],
        event_threshold: 0,
        min_interval_seconds: -1,
        retention: { keep_last: 0, keep_days: 0 },
        destinations: [
          { id: "bad id", kind: "local", path: root },
          { id: "objects", kind: "local", path: ".openwiki/objects", allow_workspace_relative: true },
          { id: "rawsecret", kind: "s3", bucket: "wiki", secret_access_key: "do-not-store" },
          { id: "bad-env", kind: "gcs", credentials_env: "not valid" },
        ],
      },
    };
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");

    const report = await validateRepository(root);
    assert.equal(report.status, "failed");
    const codes = issueCodes(report.issues);
    for (const expected of [
      "config.sync.remote.invalid",
      "config.sync.branch.invalid",
      "config.sync.mode.invalid",
      "config.sync.sync_after_events.invalid",
      "config.sync.debounce.invalid",
      "config.sync.max_attempts.invalid",
      "config.sync.backoff.invalid",
      "config.sync.interval.invalid",
      "config.sync.conflict_policy.invalid",
      "config.runtime.profile.invalid",
      "config.queue.backend.invalid",
      "config.queue.poll_ms.invalid",
      "config.queue.max_jobs_per_worker.invalid",
      "config.storage.backend.invalid",
      "config.storage.inline_max_bytes.invalid",
      "config.storage.force_path_style.invalid",
      "config.connectors.http.id.missing",
      "config.connectors.http.allowed_hosts.invalid",
      "config.connectors.github.allowed_repositories.invalid",
      "config.secrets.backend.invalid",
      "config.git.remote.invalid",
      "config.git.branch.invalid",
      "config.git.remote_url.invalid",
      "config.controls.rate_limits.enabled.invalid",
      "config.controls.rate_limits.window_ms.invalid",
      "config.controls.rate_limits.default_limit.invalid",
      "config.controls.source_fetch.max_bytes.invalid",
      "config.controls.operational_state.backend.invalid",
      "config.backups.schedule.invalid",
      "config.backups.backup_after_events.invalid",
      "config.backups.event_threshold.invalid",
      "config.backups.min_interval.invalid",
      "config.backups.retention.keep_last.invalid",
      "config.backups.retention.keep_days.invalid",
      "config.backups.destination.id.invalid",
      "config.backups.destination.path.workspace_root",
      "config.backups.destination.path.derived_state",
      "config.backups.destination.secret.invalid",
      "config.backups.destination.env.invalid",
      "config.backups.default_destination_id.required",
    ]) {
      assert.ok(codes.includes(expected), `expected ${expected}, saw ${codes.join(",")}`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validateOpenWikiConfig can allow local git remotes without mutating env", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-validation-local-remote-"));
  try {
    const config = await createWorkspace(root, "Local Remote Validation Wiki");
    const remote = path.join(root, "..", "remote.git");
    const configured: OpenWikiConfig = {
      ...config,
      runtime: {
        ...config.runtime,
        git: {
          remote_url: remote,
        },
      },
    };
    assert.deepEqual(issueCodes(validateOpenWikiConfig(configured, { root })), ["config.git.remote_url.invalid"]);
    assert.deepEqual(validateOpenWikiConfig(configured, { root, allowLocalGitRemote: true }), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime git branch validation rejects config-invalid branch shapes", () => {
  for (const branch of ["topic/", "topic.", "topic.lock", "topic@{1}", "/topic", "topic//name"]) {
    assert.throws(() => validateGitBranchName(branch), /unsupported/);
  }
  assert.doesNotThrow(() => validateGitBranchName("topic/name"));
});

test("validatePolicyBundle rejects malformed sections, grants, and approval rules", () => {
  const bundle = {
    sections: [
      { id: "", title: "No id", paths: ["wiki/**"] },
      { id: "dup", title: "First", paths: ["wiki/a/**"] },
      { id: "dup", title: "Duplicate id", paths: ["wiki/b/**"] },
      { id: "no-paths", title: "Empty paths", paths: [] },
      { id: "bad-visibility", title: "Bad visibility", paths: ["wiki/c/**"], visibility: "top-secret" },
    ],
    grants: [
      { principal: "", section: "dup", role: "editor" },
      { principal: "user:alice", section: "missing-section", role: "editor" },
      { principal: "user:bob", section: "dup", role: "not-a-role" },
    ],
    approval_rules: [
      { id: "", paths: ["wiki/**"] },
      { id: "rule-dup", paths: ["wiki/a/**"] },
      { id: "rule-dup", paths: ["wiki/b/**"] },
      { id: "rule-no-paths", paths: [] },
      { id: "rule-bad-role", paths: ["wiki/c/**"], required_reviewers: [{ role: "not-a-role" }] },
    ],
  } as unknown as OpenWikiPolicyBundle;

  const codes = issueCodes(validatePolicyBundle(bundle));
  for (const expected of [
    "policy.section.id.missing",
    "policy.section.id.duplicate",
    "policy.section.paths.empty",
    "policy.section.visibility.invalid",
    "policy.grant.principal.missing",
    "policy.grant.section.unknown",
    "policy.grant.role.invalid",
    "policy.approval_rule.id.missing",
    "policy.approval_rule.id.duplicate",
    "policy.approval_rule.paths.empty",
    "policy.approval_rule.role.invalid",
  ]) {
    assert.ok(codes.includes(expected), `expected ${expected}, saw ${codes.join(",")}`);
  }
});

test("validatePolicyBundle warns when no catch-all section exists", () => {
  const bundle = {
    sections: [{ id: "docs", title: "Docs", paths: ["wiki/docs/**"], visibility: "public" }],
    grants: [],
    approval_rules: [],
  } as unknown as OpenWikiPolicyBundle;

  const codes = issueCodes(validatePolicyBundle(bundle));
  assert.ok(codes.includes("policy.catchall.missing"));
});

test("validatePolicyBundle accepts a well-formed bundle", () => {
  const bundle = {
    sections: [{ id: "all", title: "Everything", paths: ["**"], visibility: "public" }],
    grants: [{ principal: "user:alice", section: "all", role: "contributor" }],
    approval_rules: [{ id: "default", paths: ["**"], required_reviewers: [{ role: "maintainer" }] }],
  } as unknown as OpenWikiPolicyBundle;

  assert.deepEqual(validatePolicyBundle(bundle), []);
});
