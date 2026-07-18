import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { createWorkspace } from "@openwiki/repo";
import { configureLocalBackupDestination, runPostEventAutomation } from "@openwiki/workflows";

test("event-triggered backups use configured destination selection", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-backup-automation-"));
  const primary = await mkdtemp(path.join(os.tmpdir(), "openwiki-backup-automation-primary-"));
  const secondary = await mkdtemp(path.join(os.tmpdir(), "openwiki-backup-automation-secondary-"));
  try {
    await createWorkspace(root, "Backup Automation Wiki");
    await configureLocalBackupDestination({ root, id: "primary", path: primary });
    await configureLocalBackupDestination({ root, id: "secondary", path: secondary });

    const configPath = path.join(root, "openwiki.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      runtime?: { backups?: Record<string, unknown> };
    };
    config.runtime = {
      ...(config.runtime ?? {}),
      backups: {
        ...((config.runtime?.backups) ?? {}),
        enabled: true,
        backup_after_events: ["proposal.applied"],
        default_destination_id: "primary",
      },
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const selected = await runPostEventAutomation({
      root,
      eventType: "proposal.applied",
      actorId: "actor:user:backup-automation",
      recordId: "proposal:backup-automation",
    });
    assert.equal(selected.backup?.status, "created");
    assert.equal(path.dirname(selected.backup?.backup_dir ?? ""), primary);

    config.runtime.backups = {
      ...config.runtime.backups,
      default_destination_id: undefined,
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const ambiguous = await runPostEventAutomation({
      root,
      eventType: "proposal.applied",
      actorId: "actor:user:backup-automation",
      recordId: "proposal:backup-automation-ambiguous",
    });
    assert.equal(ambiguous.backup?.status, "failed");
    assert.match(ambiguous.backup?.error ?? "", /default_destination_id/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(primary, { recursive: true, force: true });
    await rm(secondary, { recursive: true, force: true });
  }
});
