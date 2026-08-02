import assert from "node:assert/strict";
import test from "node:test";
import {
  objectStorageBackupDiagnostic,
  postgresBackupDiagnostic,
  postgresDiagnostic,
} from "../packages/cli/src/commands/doctor.ts";

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

test("hosted backup diagnostics require provider backup evidence", () => {
  assert.equal(
    postgresBackupDiagnostic(false, {
      DATABASE_URL: "postgres://openwiki:secret@127.0.0.1:5432/openwiki",
    }).status,
    "warn",
  );
  assert.equal(
    postgresBackupDiagnostic(false, {
      DATABASE_URL: "postgres://openwiki:secret@127.0.0.1:5432/openwiki",
      OPENWIKI_POSTGRES_BACKUP_CONFIGURED: "1",
    }).status,
    "pass",
  );
  assert.equal(objectStorageBackupDiagnostic({ backend: "s3", bucket: "captures" }, {}).status, "warn");
  assert.equal(objectStorageBackupDiagnostic({ backend: "s3", bucket: "captures" }, {}, "required").status, "fail");
  assert.equal(objectStorageBackupDiagnostic(undefined, {}, "required").status, "fail");
  assert.equal(
    objectStorageBackupDiagnostic(
      { backend: "s3", bucket: "captures" },
      { OPENWIKI_OBJECT_STORAGE_BACKUP_CONFIGURED: "1" },
    ).status,
    "pass",
  );
});

test("hosted Postgres diagnostic fails closed when database URL is absent", async () => {
  const oldDatabaseUrl = process.env.DATABASE_URL;
  const oldOpenWikiDatabaseUrl = process.env.OPENWIKI_DATABASE_URL;
  try {
    delete process.env.DATABASE_URL;
    delete process.env.OPENWIKI_DATABASE_URL;
    const check = await postgresDiagnostic(process.cwd(), "required");
    assert.equal(check.name, "postgres");
    assert.equal(check.status, "fail");
    assert.match(check.message, /requires OPENWIKI_DATABASE_URL or DATABASE_URL/);
  } finally {
    restoreEnv("DATABASE_URL", oldDatabaseUrl);
    restoreEnv("OPENWIKI_DATABASE_URL", oldOpenWikiDatabaseUrl);
  }
});
