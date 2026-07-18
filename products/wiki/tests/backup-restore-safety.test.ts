import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { createWorkspace } from "@openwiki/repo";
import { createWorkspaceBackup, restoreWorkspaceBackup } from "@openwiki/workflows";

test("backup restore refuses to replace symlinked target roots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-backup-symlink-source-"));
  const targetParent = await mkdtemp(path.join(os.tmpdir(), "openwiki-backup-symlink-target-"));
  const outsideTarget = path.join(targetParent, "outside");
  const symlinkTarget = path.join(targetParent, "target-link");
  try {
    await createWorkspace(root, "Backup Wiki");
    const backup = await createWorkspaceBackup({
      root,
      outDir: path.join(root, "backups"),
    });

    await mkdir(outsideTarget);
    await createWorkspace(outsideTarget, "Backup Wiki");
    await writeFile(path.join(outsideTarget, "important.txt"), "outside target must survive\n", "utf8");
    await symlink(outsideTarget, symlinkTarget, "dir");

    await assert.rejects(
      restoreWorkspaceBackup({
        backupDir: backup.backup_dir,
        targetRoot: symlinkTarget,
        force: true,
      }),
      /Refusing to restore into symlinked target root/,
    );
    assert.equal(await readFile(path.join(outsideTarget, "important.txt"), "utf8"), "outside target must survive\n");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(targetParent, { recursive: true, force: true });
  }
});
