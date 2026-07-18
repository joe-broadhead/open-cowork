import { corsHeaders, securityHeaders } from "./request.ts";
import { webAssetReader, type WebAssetReader } from "@openwiki/web";
import { createHash } from "node:crypto";
import type { ServerResponse } from "node:http";

export function webAssetNameFromUrl(rawUrl: string): string | undefined {
  const url = new URL(rawUrl, "http://openwiki.local");
  if (!url.pathname.startsWith("/_assets/")) {
    return undefined;
  }
  return url.pathname.slice("/_assets/".length);
}

export async function writeWebAsset(response: ServerResponse, name: string, headOnly: boolean, ifNoneMatch?: string, assets: WebAssetReader = webAssetReader()): Promise<void> {
  const asset = await assets.read(name);
  if (asset === undefined) {
    writeAssetNotFound(response, headOnly);
    return;
  }
  const etag = assetEtag(asset.body);
  const cacheControl = asset.immutable ? "public, max-age=31536000, immutable" : "no-cache";
  if (matchesIfNoneMatch(ifNoneMatch, etag)) {
    response.writeHead(304, {
      ...corsHeaders(),
      ...securityHeaders(asset.contentType),
      "cache-control": cacheControl,
      "etag": etag,
    });
    response.end();
    return;
  }
  response.writeHead(200, {
    ...corsHeaders(),
    ...securityHeaders(asset.contentType),
    "cache-control": cacheControl,
    "content-length": String(asset.body.byteLength),
    "content-type": asset.contentType,
    "etag": etag,
  });
  response.end(headOnly ? undefined : asset.body);
}

function writeAssetNotFound(response: ServerResponse, headOnly: boolean): void {
  response.writeHead(404, {
    ...corsHeaders(),
    ...securityHeaders("text/plain; charset=utf-8"),
    "content-type": "text/plain; charset=utf-8",
  });
  response.end(headOnly ? undefined : "Not found\n");
}

function assetEtag(body: Buffer): string {
  return `"sha256-${createHash("sha256").update(body).digest("base64url")}"`;
}

function matchesIfNoneMatch(value: string | undefined, etag: string): boolean {
  if (value === undefined) {
    return false;
  }
  return value
    .split(",")
    .map((candidate) => candidate.trim())
    .some((candidate) => candidate === "*" || candidate === etag || candidate === `W/${etag}`);
}
