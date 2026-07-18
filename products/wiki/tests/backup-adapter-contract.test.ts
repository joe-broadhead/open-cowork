import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { OPENWIKI_PROTOCOL_VERSION, OPENWIKI_REPO_FORMAT } from "@openwiki/core";
import { listCloudBackups, uniqueCloudBackupId, type CloudBackupDestinationHandle } from "../packages/workflows/src/backup-cloud.ts";
import {
  FakeCloudBackupDestinationAdapter,
  registerCloudBackupAdapterConformanceTests,
} from "./support/backup-adapter-conformance.ts";

registerCloudBackupAdapterConformanceTests("fake cloud backup adapter", () => new FakeCloudBackupDestinationAdapter());

test("cloud backup listing marks partial and checksum-mismatched backups invalid", async () => {
  const adapter = new FakeCloudBackupDestinationAdapter();
  const handle: CloudBackupDestinationHandle = {
    config: {
      id: "contract",
      kind: "s3",
      bucket: "fake-backups",
      access_key_id_env: "OPENWIKI_FAKE_ACCESS_KEY_ID",
      secret_access_key_env: "OPENWIKI_FAKE_SECRET_ACCESS_KEY",
    },
    destination: {
      id: "contract",
      kind: "s3",
      uri: "memory://fake-backups/contract/workspace-contract",
      prefix: "contract/workspace-contract",
    },
    adapter,
    basePrefix: "contract/workspace-contract",
  };

  adapter.seedObject("contract/workspace-contract/openwiki-backup-partial/repo/openwiki.json", "{}");
  const badChecksumId = "openwiki-backup-checksum";
  adapter.seedObject(
    `contract/workspace-contract/${badChecksumId}/manifest.json`,
    JSON.stringify(backupManifest(badChecksumId, sha256Hex("different-checksum-file")), null, 2),
  );
  adapter.seedObject(`contract/workspace-contract/${badChecksumId}/checksums.sha256`, "not the declared checksum\n");

  const backups = await listCloudBackups(handle);
  assert.deepEqual(
    backups.map((backup) => [backup.backup_id, backup.status]),
    [
      [badChecksumId, "invalid"],
      ["openwiki-backup-partial", "invalid"],
    ],
  );
  assert.match(backups.find((backup) => backup.backup_id === badChecksumId)?.error ?? "", /checksum file hash does not match/);
});

test("cloud backup listing rejects provider objects outside the destination prefix", async () => {
  const adapter = new FakeCloudBackupDestinationAdapter();
  const handle: CloudBackupDestinationHandle = {
    config: {
      id: "contract",
      kind: "s3",
      bucket: "fake-backups",
      access_key_id_env: "OPENWIKI_FAKE_ACCESS_KEY_ID",
      secret_access_key_env: "OPENWIKI_FAKE_SECRET_ACCESS_KEY",
    },
    destination: {
      id: "contract",
      kind: "s3",
      uri: "memory://fake-backups/contract/workspace-contract",
      prefix: "contract/workspace-contract",
    },
    adapter,
    basePrefix: "contract/workspace-contract",
  };
  adapter.listedObjectsOverride = [
    { key: "contract/workspace-contract/openwiki-backup-good/manifest.json" },
    { key: "contract-other/workspace-contract/openwiki-backup-bad/manifest.json" },
  ];

  await assert.rejects(
    listCloudBackups(handle),
    /Backup provider listed invalid object keys under prefix: contract-other\/workspace-contract\/openwiki-backup-bad\/manifest\.json/,
  );
});

test("cloud backup ids include entropy before provider existence checks", async () => {
  const adapter = new FakeCloudBackupDestinationAdapter();
  const handle = fakeHandle(adapter);
  const baseId = "openwiki-backup-workspace-contract-2026-01-01T00-00-00-000Z";

  const ids = await Promise.all([uniqueCloudBackupId(handle, baseId), uniqueCloudBackupId(handle, baseId)]);

  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) {
    assert.match(id, /^openwiki-backup-workspace-contract-2026-01-01T00-00-00-000Z-[0-9a-f]{12}$/);
  }
});

function fakeHandle(adapter: FakeCloudBackupDestinationAdapter): CloudBackupDestinationHandle {
  return {
    config: {
      id: "contract",
      kind: "s3",
      bucket: "fake-backups",
      access_key_id_env: "OPENWIKI_FAKE_ACCESS_KEY_ID",
      secret_access_key_env: "OPENWIKI_FAKE_SECRET_ACCESS_KEY",
    },
    destination: {
      id: "contract",
      kind: "s3",
      uri: "memory://fake-backups/contract/workspace-contract",
      prefix: "contract/workspace-contract",
    },
    adapter,
    basePrefix: "contract/workspace-contract",
  };
}

function backupManifest(backupId: string, checksumFileHash: string) {
  return {
    schema_version: "openwiki.backup.v1",
    backup_id: backupId,
    openwiki_version: "0.0.0",
    workspace_id: "workspace:contract",
    workspace_title: "Contract Wiki",
    protocol_version: OPENWIKI_PROTOCOL_VERSION,
    repo_format: OPENWIKI_REPO_FORMAT,
    created_at: "2026-01-01T00:00:00.000Z",
    created_by_actor: "actor:user:local",
    created_on_host: "contract.test",
    source_dirty: false,
    included_paths: ["openwiki.json"],
    derived_stores: {
      search_index: "excluded",
      sqlite_index: "excluded",
    },
    object_storage: {
      mode: "local",
      external_objects_included: true,
      restore_complete_from_git: true,
    },
    postgres: {
      included: false,
    },
    checksum_file: "checksums.sha256",
    checksum_file_hash: checksumFileHash,
    file_count: 1,
    byte_count: 1,
    compatibility: {
      min_openwiki_version: "0.0.0",
      protocol_version: OPENWIKI_PROTOCOL_VERSION,
      repo_format: OPENWIKI_REPO_FORMAT,
      requires_checksum_verification: true,
    },
    warnings: [],
    counts: {
      pages: 0,
      sources: 0,
      claims: 0,
      proposals: 0,
      decisions: 0,
      events: 0,
      runs: 0,
    },
  };
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
