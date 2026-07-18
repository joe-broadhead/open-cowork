import assert from "node:assert/strict";
import test from "node:test";
import {
  backupDestinationStatusFromConfig,
  deleteBackupObjectPrefix,
  defaultBackupDestinationCapabilities,
  normalizeBackupObjectKey,
  normalizeBackupObjectPrefix,
  putVerifiedCloudBackupObject,
  type BackupDestinationStatus,
  type CloudBackupDestinationAdapter,
  type CloudBackupObject,
  type PutCloudBackupObjectInput,
} from "@openwiki/storage";

export type FakeBackupFailureMode = "auth" | "quota" | "rate_limit" | "provider_unavailable";

export class FakeCloudBackupDestinationAdapter implements CloudBackupDestinationAdapter {
  readonly kind = "s3" as const;
  readonly id = "fake";
  readonly baseUri = "memory://fake-backups";
  readonly objects = new Map<string, { data: Buffer; updated_at: string }>();
  partialWriteKeys = new Set<string>();
  listedObjectsOverride?: CloudBackupObject[];
  deletedKeys: string[] = [];
  failureMode?: FakeBackupFailureMode;

  async status(prefix?: string): Promise<BackupDestinationStatus> {
    const base = backupDestinationStatusFromConfig({
      id: this.id,
      kind: "s3",
      bucket: "fake-backups",
      ...(prefix === undefined ? {} : { prefix }),
      access_key_id_env: "OPENWIKI_FAKE_ACCESS_KEY_ID",
      secret_access_key_env: "OPENWIKI_FAKE_SECRET_ACCESS_KEY",
    }, {
      providerIdentity: this.baseUri,
      ...(prefix === undefined ? {} : { configuredPrefix: prefix }),
    });
    if (this.failureMode === undefined) {
      return {
        ...base,
        readiness: "ok",
        credential_state: "env_configured",
        diagnostics: [],
      };
    }
    return {
      ...base,
      readiness: "degraded",
      credential_state: "env_configured",
      diagnostics: [{
        code: `provider.${this.failureMode}`,
        severity: "error",
        message: `Fake provider state: ${this.failureMode}`,
      }],
    };
  }

  async putObject(input: PutCloudBackupObjectInput): Promise<void> {
    this.assertAvailable();
    const key = normalizeBackupObjectKey(input.key);
    const data = this.partialWriteKeys.has(key)
      ? Buffer.from(input.data.subarray(0, Math.max(1, Math.floor(input.data.byteLength / 2))))
      : Buffer.from(input.data);
    this.objects.set(key, { data, updated_at: new Date(0).toISOString() });
  }

  async getObject(key: string): Promise<Buffer> {
    this.assertAvailable();
    const normalized = normalizeBackupObjectKey(key);
    const object = this.objects.get(normalized);
    if (object === undefined) {
      throw new Error(`Fake backup object was not found: ${normalized}`);
    }
    return Buffer.from(object.data);
  }

  async listObjects(prefix: string): Promise<CloudBackupObject[]> {
    this.assertAvailable();
    if (this.listedObjectsOverride !== undefined) {
      return this.listedObjectsOverride;
    }
    const normalized = normalizeBackupObjectPrefix(prefix);
    return [...this.objects.entries()]
      .filter(([key]) => key === normalized || key.startsWith(`${normalized}/`))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, object]) => ({ key, size: object.data.byteLength, updated_at: object.updated_at }));
  }

  async deleteObject(key: string): Promise<void> {
    const normalized = normalizeBackupObjectKey(key);
    this.deletedKeys.push(normalized);
    this.objects.delete(normalized);
  }

  async deletePrefix(prefix: string): Promise<void> {
    await deleteBackupObjectPrefix({
      prefix,
      listObjects: (listPrefix) => this.listObjects(listPrefix),
      deleteObject: (key) => this.deleteObject(key),
    });
  }

  seedObject(key: string, data: Buffer | string): void {
    this.objects.set(normalizeBackupObjectKey(key), {
      data: Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(data, "utf8"),
      updated_at: new Date(0).toISOString(),
    });
  }

  private assertAvailable(): void {
    if (this.failureMode !== undefined) {
      throw new Error(`Fake provider ${this.failureMode}`);
    }
  }
}

export function registerCloudBackupAdapterConformanceTests(
  name: string,
  factory: () => FakeCloudBackupDestinationAdapter,
): void {
  test(`${name}: object lifecycle and status contract`, async () => {
    process.env.OPENWIKI_FAKE_ACCESS_KEY_ID = "fake";
    process.env.OPENWIKI_FAKE_SECRET_ACCESS_KEY = "fake";
    const adapter = factory();
    const status = await adapter.status("contract/workspace");
    assert.equal(status.readiness, "ok");
    assert.equal(status.credential_state, "env_configured");
    assert.deepEqual(status.capabilities, defaultBackupDestinationCapabilities());
    assert.deepEqual(status.diagnostics, []);

    await putVerifiedCloudBackupObject(adapter, {
      key: "contract/workspace/openwiki-backup-1/manifest.json",
      data: Buffer.from("{\"ok\":true}\n"),
      contentType: "application/json",
    });
    assert.equal((await adapter.getObject("contract/workspace/openwiki-backup-1/manifest.json")).toString("utf8"), "{\"ok\":true}\n");
    assert.deepEqual(
      (await adapter.listObjects("contract/workspace/openwiki-backup-1/")).map((object) => object.key),
      ["contract/workspace/openwiki-backup-1/manifest.json"],
    );
    await adapter.deletePrefix("contract/workspace/openwiki-backup-1/");
    assert.deepEqual(await adapter.listObjects("contract/workspace/openwiki-backup-1/"), []);
  });

  test(`${name}: rejects unsafe object keys and confines prefix deletes`, async () => {
    const adapter = factory();
    await assert.rejects(
      putVerifiedCloudBackupObject(adapter, { key: "../escape", data: Buffer.from("bad") }),
      /Invalid backup object key/,
    );
    await assert.rejects(
      putVerifiedCloudBackupObject(adapter, { key: "contract/-provider-option", data: Buffer.from("bad") }),
      /Invalid backup object key/,
    );
    adapter.seedObject("contract/workspace/a.txt", "a");
    adapter.seedObject("contract/workspace/nested/b.txt", "b");
    adapter.seedObject("contract-other/workspace/c.txt", "c");
    await adapter.deletePrefix("contract/workspace/");
    assert.deepEqual([...adapter.objects.keys()].sort(), ["contract-other/workspace/c.txt"]);
  });

  test(`${name}: validates every listed key before deleting a prefix`, async () => {
    const adapter = factory();
    adapter.seedObject("contract/workspace/a.txt", "a");
    adapter.listedObjectsOverride = [
      { key: "contract/workspace/a.txt" },
      { key: "contract-other/workspace/c.txt" },
    ];

    await assert.rejects(
      adapter.deletePrefix("contract/workspace/"),
      /Backup provider listed invalid object keys under prefix: contract-other\/workspace\/c\.txt/,
    );
    assert.deepEqual(adapter.deletedKeys, []);
    assert.equal(adapter.objects.has("contract/workspace/a.txt"), true);
  });

  test(`${name}: rejects normalized-looking but non-canonical listed keys`, async () => {
    for (const key of [
      "/contract/workspace/a.txt",
      "contract\\workspace\\a.txt",
      "contract/workspace/a.txt ",
      "contract-other/workspace/token=provider-secret.txt",
    ]) {
      const adapter = factory();
      adapter.seedObject("contract/workspace/a.txt", "a");
      adapter.listedObjectsOverride = [{ key }];

      await assert.rejects(
        adapter.deletePrefix("contract/workspace/"),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /Backup provider listed invalid object keys under prefix/);
          assert.doesNotMatch(error.message, /provider-secret/);
          return true;
        },
      );
      assert.deepEqual(adapter.deletedKeys, []);
      assert.equal(adapter.objects.has("contract/workspace/a.txt"), true);
    }
  });

  test(`${name}: detects and removes partial upload readback mismatches`, async () => {
    const adapter = factory();
    adapter.partialWriteKeys.add("contract/workspace/partial.bin");
    await assert.rejects(
      putVerifiedCloudBackupObject(adapter, {
        key: "contract/workspace/partial.bin",
        data: Buffer.from("complete-object"),
      }),
      /partial or corrupted object/,
    );
    assert.equal(adapter.objects.has("contract/workspace/partial.bin"), false);
  });

  test(`${name}: reports provider auth, quota, rate-limit, and unavailable states`, async () => {
    for (const mode of ["auth", "quota", "rate_limit", "provider_unavailable"] as const) {
      const adapter = factory();
      adapter.failureMode = mode;
      const status = await adapter.status("contract/workspace");
      assert.equal(status.readiness, "degraded");
      assert.equal(status.diagnostics[0]?.code, `provider.${mode}`);
    }
  });
}
