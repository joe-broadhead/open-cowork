import http from "node:http";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import {
  checkContentStoreHealth,
  cloudBackupObjectUri,
  createCloudBackupDestination,
  createContentStore,
} from "@openwiki/storage";
import { createWorkspace, readSourceContent } from "@openwiki/repo";
import { ingestSource } from "@openwiki/workflows";
import type { OpenWikiConfig } from "@openwiki/core";

test("local object store verifies content-addressed objects on read", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-local-object-"));
  try {
    const store = await createContentStore(root, { backend: "local" });
    const stored = await store.put({
      data: "local object evidence",
      namespace: "sources",
      extension: "txt",
    });
    const read = await store.get(stored.path);
    assert.equal(read.data.toString("utf8"), "local object evidence");
    assert.equal(read.content_hash, stored.content_hash);

    await writeFile(path.join(root, stored.path), "tampered");
    await assert.rejects(store.get(stored.path), /content hash mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("S3-compatible object store signs PUT/GET requests and reports health", async () => {
  const server = await startObjectServer();
  const env = snapshotEnv(["OPENWIKI_TEST_S3_ACCESS_KEY", "OPENWIKI_TEST_S3_SECRET_KEY"]);
  try {
    process.env.OPENWIKI_TEST_S3_ACCESS_KEY = "test-access";
    process.env.OPENWIKI_TEST_S3_SECRET_KEY = "test-secret";
    const config = {
      backend: "minio" as const,
      endpoint_url: server.url,
      bucket: "openwiki-test",
      region: "us-test-1",
      prefix: "tenant/workspace",
      access_key_id_env: "OPENWIKI_TEST_S3_ACCESS_KEY",
      secret_access_key_env: "OPENWIKI_TEST_S3_SECRET_KEY",
      inline_max_bytes: 0,
    };
    const health = await checkContentStoreHealth(process.cwd(), config);
    assert.equal(health.status, "ok");
    assert.equal(health.backend, "minio");

    const store = await createContentStore(process.cwd(), config);
    const stored = await store.put({
      data: "S3 compatible OpenWiki object",
      namespace: "sources",
      extension: "txt",
      mediaType: "text/plain; charset=utf-8",
    });

    assert.equal(stored.backend, "minio");
    assert.equal(stored.bucket, "openwiki-test");
    assert.match(stored.path, /^s3:\/\/openwiki-test\/tenant\/workspace\/sources\/sha256\//);
    assert.ok(server.requests.some((request) => request.method === "PUT" && request.authorization.includes("AWS4-HMAC-SHA256")));

    const read = await store.get(stored.path);
    assert.equal(read.data.toString("utf8"), "S3 compatible OpenWiki object");
    assert.equal(read.backend, "minio");
    assert.equal(read.content_hash, stored.content_hash);
    assert.ok(server.requests.some((request) => request.method === "GET" && request.authorization.includes("AWS4-HMAC-SHA256")));
    await assert.rejects(
      store.get(stored.path.replace("s3://openwiki-test/", "s3://other-bucket/")),
      /Invalid S3 object bucket/u,
    );
    await assert.rejects(
      store.get(stored.path.replace("tenant/workspace/", "other/workspace/")),
      /outside configured prefix/u,
    );
    await assert.rejects(
      store.get("s3://openwiki-test/tenant/workspace/%2e%2e/secret.txt"),
      /Invalid S3 object key/u,
    );

    const preview = await store.get(stored.path, { maxBytes: 4 });
    assert.equal(preview.data.toString("utf8"), "S3 c");
    assert.equal(preview.bytes, Buffer.byteLength("S3 compatible OpenWiki object"));
    assert.equal(preview.content_hash, undefined);
    assert.ok(server.requests.some((request) => request.method === "GET" && request.range === "bytes=0-3"));
  } finally {
    restoreEnv(env);
    await server.close();
  }
});

test("S3-compatible partial reads do not invent total bytes without Content-Range", async () => {
  const server = await startObjectServer({ contentRange: false });
  const env = snapshotEnv(["OPENWIKI_TEST_S3_ACCESS_KEY", "OPENWIKI_TEST_S3_SECRET_KEY"]);
  try {
    process.env.OPENWIKI_TEST_S3_ACCESS_KEY = "test-access";
    process.env.OPENWIKI_TEST_S3_SECRET_KEY = "test-secret";
    const store = await createContentStore(process.cwd(), {
      backend: "minio",
      endpoint_url: server.url,
      bucket: "openwiki-test",
      region: "us-test-1",
      access_key_id_env: "OPENWIKI_TEST_S3_ACCESS_KEY",
      secret_access_key_env: "OPENWIKI_TEST_S3_SECRET_KEY",
      inline_max_bytes: 0,
    });
    const stored = await store.put({
      data: "S3 compatible OpenWiki object",
      namespace: "sources",
      extension: "txt",
      mediaType: "text/plain; charset=utf-8",
    });
    const preview = await store.get(stored.path, { maxBytes: 4 });
    assert.equal(preview.data.toString("utf8"), "S3 c");
    assert.equal(preview.bytes, 4);
    assert.equal(preview.truncated, true);
  } finally {
    restoreEnv(env);
    await server.close();
  }
});

test("S3-compatible backup deletePrefix rejects out-of-prefix listed objects", async () => {
  const env = snapshotEnv(["OPENWIKI_TEST_S3_ACCESS_KEY", "OPENWIKI_TEST_S3_SECRET_KEY"]);
  const deletedPaths: string[] = [];
  try {
    process.env.OPENWIKI_TEST_S3_ACCESS_KEY = "test-access";
    process.env.OPENWIKI_TEST_S3_SECRET_KEY = "test-secret";
    const adapter = createCloudBackupDestination({
      id: "prefix-delete",
      kind: "minio",
      endpoint_url: "https://storage.example.test",
      bucket: "openwiki-test",
      region: "us-test-1",
      access_key_id_env: "OPENWIKI_TEST_S3_ACCESS_KEY",
      secret_access_key_env: "OPENWIKI_TEST_S3_SECRET_KEY",
    });

    await withMockFetch(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if ((init?.method ?? "GET") === "GET" && url.searchParams.get("list-type") === "2") {
        return new Response([
          "<ListBucketResult>",
          "<Contents><Key>tenant/workspace/backup/manifest.json</Key><Size>1</Size></Contents>",
          "<Contents><Key>tenant/other/backup/manifest.json</Key><Size>1</Size></Contents>",
          "<Contents><Key>tenant/workspace/backup/../escape.json</Key><Size>1</Size></Contents>",
          "</ListBucketResult>",
        ].join(""), { status: 200, headers: { "content-type": "application/xml" } });
      }
      if ((init?.method ?? "GET") === "DELETE") {
        deletedPaths.push(url.pathname);
        return new Response(null, { status: 204 });
      }
      return new Response("unexpected", { status: 500 });
    }, async () => {
      await assert.rejects(
        adapter.deletePrefix("tenant/workspace/backup"),
        /Backup provider listed invalid object keys under prefix: tenant\/other\/backup\/manifest\.json, tenant\/workspace\/backup\/\.\.\/escape\.json/,
      );
    });

    assert.deepEqual(deletedPaths, []);
  } finally {
    restoreEnv(env);
  }
});

test("cloud backup destination adapters cover GCS object lifecycles", async () => {
  const env = snapshotEnv(["OPENWIKI_TEST_GCS_CREDENTIALS"]);
  try {
    const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    process.env.OPENWIKI_TEST_GCS_CREDENTIALS = JSON.stringify({
      client_email: "openwiki-backups@example.test",
      private_key: keyPair.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      token_uri: "https://oauth2.example/token",
    });
    const gcsObjects = new Map<string, Buffer>();
    await withMockFetch(async (input, init) => {
      const url = new URL(String(input));
      if (url.href === "https://oauth2.example/token") {
        assert.equal(init?.method, "POST");
        return jsonResponse({ access_token: "gcs-token" });
      }
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer gcs-token");
      if (url.pathname.startsWith("/upload/storage/v1/b/gcs-bucket/o")) {
        assert.equal(init?.method, "POST");
        assert.equal(new Headers(init?.headers).get("x-goog-encryption-kms-key-name"), "projects/p/locations/global/keyRings/r/cryptoKeys/k");
        gcsObjects.set(url.searchParams.get("name") ?? "", Buffer.from(await new Response(init?.body as BodyInit).arrayBuffer()));
        return jsonResponse({ name: url.searchParams.get("name") });
      }
      if (url.searchParams.get("alt") === "media") {
        const object = gcsObjects.get(decodeURIComponent(url.pathname.split("/o/")[1] ?? ""));
        return object === undefined ? new Response("", { status: 404, statusText: "Not Found" }) : new Response(object.toString("utf8"));
      }
      if (init?.method === "DELETE") {
        gcsObjects.delete(decodeURIComponent(url.pathname.split("/o/")[1] ?? ""));
        return new Response(null, { status: 204, statusText: "No Content" });
      }
      if (url.pathname === "/storage/v1/b/gcs-bucket/o") {
        return jsonResponse({
          items: [...gcsObjects.entries()].map(([name, data]) => ({
            name,
            size: String(data.byteLength),
            updated: "2026-01-01T00:00:00.000Z",
          })),
        });
      }
      return new Response("", { status: 404, statusText: "Not Found" });
    }, async () => {
      const gcs = createCloudBackupDestination({
        id: "gcs-test",
        kind: "gcs",
        bucket: "gcs-bucket",
        credentials_env: "OPENWIKI_TEST_GCS_CREDENTIALS",
        kms_key_name: "projects/p/locations/global/keyRings/r/cryptoKeys/k",
      });
      await gcs.putObject({ key: "prefix/workspace/manifest.json", data: Buffer.from("{\"ok\":true}"), contentType: "application/json" });
      assert.equal((await gcs.getObject("prefix/workspace/manifest.json")).toString("utf8"), "{\"ok\":true}");
      assert.deepEqual((await gcs.listObjects("prefix/")).map((object) => object.key), ["prefix/workspace/manifest.json"]);
      assert.equal(
        cloudBackupObjectUri({ id: "gcs-test", kind: "gcs", bucket: "gcs-bucket" }, "prefix/workspace/manifest.json"),
        "gs://gcs-bucket/prefix/workspace/manifest.json",
      );
      await gcs.deleteObject("prefix/workspace/manifest.json");
      assert.equal((await gcs.listObjects("prefix/")).length, 0);
      gcsObjects.set("prefix/workspace/manifest.json", Buffer.from("{}"));
      gcsObjects.set("prefix-other/workspace/manifest.json", Buffer.from("{}"));
      await assert.rejects(
        gcs.deletePrefix("prefix/workspace/"),
        /Backup provider listed invalid object keys under prefix: prefix-other\/workspace\/manifest\.json/,
      );
      assert.equal(gcsObjects.has("prefix/workspace/manifest.json"), true);
      assert.equal(gcsObjects.has("prefix-other/workspace/manifest.json"), true);
    });
  } finally {
    restoreEnv(env);
  }
});

test("cloud backup provider errors redact URLs and credentials", async () => {
  const env = snapshotEnv(["OPENWIKI_TEST_GCS_CREDENTIALS"]);
  try {
    const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    process.env.OPENWIKI_TEST_GCS_CREDENTIALS = JSON.stringify({
      client_email: "openwiki-backups@example.test",
      private_key: keyPair.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      token_uri: "https://oauth2.example/token",
    });
    await withMockFetch(async (input) => {
      const url = new URL(String(input));
      if (url.href === "https://oauth2.example/token") {
        return jsonResponse({ access_token: "secret-gcs-token" });
      }
      return new Response("do not leak this response body", { status: 403, statusText: "Forbidden" });
    }, async () => {
      const gcs = createCloudBackupDestination({
        id: "gcs-error-test",
        kind: "gcs",
        bucket: "gcs-bucket",
        credentials_env: "OPENWIKI_TEST_GCS_CREDENTIALS",
      });
      await assert.rejects(
        gcs.putObject({ key: "prefix/manifest.json", data: Buffer.from("{}") }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /GCS backup upload failed: HTTP 403 Forbidden/);
          assert.doesNotMatch(error.message, /secret-gcs-token|do not leak|storage\.googleapis\.com|gcs-bucket/u);
          return true;
        },
      );
    });
  } finally {
    restoreEnv(env);
  }
});

test("source ingestion can store and read captured content through MinIO-compatible storage", async () => {
  const server = await startObjectServer();
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-minio-source-"));
  const env = snapshotEnv(["OPENWIKI_TEST_MINIO_ACCESS_KEY", "OPENWIKI_TEST_MINIO_SECRET_KEY"]);
  try {
    process.env.OPENWIKI_TEST_MINIO_ACCESS_KEY = "minio-access";
    process.env.OPENWIKI_TEST_MINIO_SECRET_KEY = "minio-secret";
    await createWorkspace(root, "MinIO Source Wiki");
    const configPath = path.join(root, "openwiki.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as OpenWikiConfig;
    config.runtime = {
      ...(config.runtime ?? {}),
      storage: {
        backend: "minio",
        endpoint_url: server.url,
        bucket: "openwiki-test",
        region: "us-test-1",
        prefix: "company/wiki",
        access_key_id_env: "OPENWIKI_TEST_MINIO_ACCESS_KEY",
        secret_access_key_env: "OPENWIKI_TEST_MINIO_SECRET_KEY",
        inline_max_bytes: 0,
      },
    };
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");

    const result = await ingestSource({
      root,
      title: "MinIO Evidence",
      sourceType: "manual",
      content: "MinIO backed source evidence",
      actorId: "actor:user:researcher",
    });

    assert.equal(result.raw_path, undefined);
    assert.equal(result.source.storage?.backend, "minio");
    assert.match(String(result.source.storage?.path), /^s3:\/\/openwiki-test\/company\/wiki\/sources\/sha256\//);
    const content = await readSourceContent(root, result.source.id, { maxBytes: 1024 });
    assert.equal(content.content?.backend, "minio");
    assert.equal(content.content?.hash_verified, true);
    assert.match(content.content?.body ?? "", /MinIO backed source evidence/);

    const preview = await readSourceContent(root, result.source.id, { maxBytes: 4 });
    assert.equal(preview.content?.truncated, true);
    assert.equal(preview.content?.hash_verified, undefined);

    const sourceManifestPath = path.join(root, result.source.path);
    const manifest = await readFile(sourceManifestPath, "utf8");
    const hashMismatchManifest = manifest.replace(/\n  content_hash: sha256:[0-9a-f]{64}/u, `\n  content_hash: sha256:${"0".repeat(64)}`);
    assert.notEqual(hashMismatchManifest, manifest);
    await writeFile(sourceManifestPath, hashMismatchManifest, "utf8");
    const hashMismatch = await readSourceContent(root, result.source.id, { maxBytes: 1024 });
    assert.equal(hashMismatch.content, null);
    assert.equal(hashMismatch.unavailable_reason, "hash_mismatch");

    const crossBucketManifest = manifest.replace(/\n  path: s3:\/\/openwiki-test\//u, "\n  path: s3://other-bucket/");
    assert.notEqual(crossBucketManifest, manifest);
    const requestCountBeforeInvalidStorage = server.requests.length;
    await writeFile(sourceManifestPath, crossBucketManifest, "utf8");
    const invalidStorage = await readSourceContent(root, result.source.id, { maxBytes: 1024 });
    assert.equal(invalidStorage.content, null);
    assert.equal(invalidStorage.unavailable_reason, "invalid_storage");
    assert.equal(server.requests.length, requestCountBeforeInvalidStorage);

    const missingManifest = manifest.replace(/\n  path: [^\n]+/u, `\n  path: s3://openwiki-test/company/wiki/sources/sha256/00/${"0".repeat(64)}.txt`);
    assert.notEqual(missingManifest, manifest);
    await writeFile(sourceManifestPath, missingManifest, "utf8");
    const missing = await readSourceContent(root, result.source.id, { maxBytes: 1024 });
    assert.equal(missing.content, null);
    assert.equal(missing.unavailable_reason, "missing");
  } finally {
    restoreEnv(env);
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

interface ObjectServer {
  url: string;
  requests: Array<{ method: string; path: string; authorization: string; range: string }>;
  close(): Promise<void>;
}

async function startObjectServer(options: { contentRange?: boolean } = {}): Promise<ObjectServer> {
  const objects = new Map<string, Buffer>();
  const requests: ObjectServer["requests"] = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const key = url.pathname;
    requests.push({
      method: request.method ?? "GET",
      path: key,
      authorization: request.headers.authorization ?? "",
      range: typeof request.headers.range === "string" ? request.headers.range : "",
    });
    if (request.method === "PUT") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        objects.set(key, Buffer.concat(chunks));
        response.writeHead(200);
        response.end();
      });
      return;
    }
    if (request.method === "GET") {
      const object = objects.get(key);
      if (!object) {
        response.writeHead(404);
        response.end();
        return;
      }
      const range = typeof request.headers.range === "string" ? /^bytes=0-(\d+)$/.exec(request.headers.range) : null;
      if (range !== null) {
        const requestedEnd = Number(range[1]);
        const end = Math.min(requestedEnd, object.byteLength - 1);
        const chunk = object.subarray(0, end + 1);
        response.writeHead(206, {
          "content-type": "text/plain; charset=utf-8",
          "content-length": String(chunk.byteLength),
          ...(options.contentRange === false ? {} : { "content-range": `bytes 0-${end}/${object.byteLength}` }),
        });
        response.end(chunk);
        return;
      }
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8", "content-length": String(object.byteLength) });
      response.end(object);
      return;
    }
    response.writeHead(405);
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("Expected HTTP test server to listen on a TCP port");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function snapshotEnv(keys: string[]): Map<string, string | undefined> {
  return new Map(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(values: Map<string, string | undefined>): void {
  for (const [key, value] of values) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

async function withMockFetch(
  handler: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
  run: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = handler as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
