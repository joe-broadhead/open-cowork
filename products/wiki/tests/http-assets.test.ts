import { writeWebAsset } from "../packages/http-api/src/assets.ts";
import { webAssetReader } from "../packages/web/src/assets.ts";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const webSourceRoot = path.resolve("packages/web");

test("direct web asset helper builds assets when manifest is absent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-http-assets-"));
  await cp(path.join(webSourceRoot, "src", "styles"), path.join(root, "src", "styles"), { recursive: true });
  await cp(path.join(webSourceRoot, "src", "client"), path.join(root, "src", "client"), { recursive: true });
  const server = createServer((request, response) => {
    writeWebAsset(response, "openwiki.css", request.method === "HEAD", undefined, webAssetReader({ root })).catch((error: unknown) => {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end(error instanceof Error ? error.message : String(error));
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/_assets/openwiki.css`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/css; charset=utf-8");
    assert.match(await response.text(), /:root/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("direct web asset helper rejects invalid names before building assets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-http-assets-invalid-"));
  const server = createServer((request, response) => {
    writeWebAsset(response, "../openwiki.css", request.method === "HEAD", undefined, webAssetReader({ root })).catch((error: unknown) => {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end(error instanceof Error ? error.message : String(error));
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/_assets/../openwiki.css`);
    assert.equal(response.status, 404);
    assert.equal(await response.text(), "Not found\n");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
