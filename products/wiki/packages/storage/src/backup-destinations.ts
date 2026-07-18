import { createHash, createHmac, createSign } from "node:crypto";
import { promises as fs } from "node:fs";
import type { OpenWikiBackupDestinationConfig } from "@openwiki/core";
import {
  backupDestinationStatusFromConfig,
  deleteBackupObjectPrefix,
  normalizeBackupObjectKey,
  type BackupDestinationStatus,
} from "./backup-contract.ts";
import { createRcloneBackupDestination, rcloneBackupObjectUri } from "./rclone-backup.ts";

export type CloudBackupDestinationKind = "s3" | "minio" | "gcs" | "rclone";

export interface CloudBackupObject {
  key: string;
  size?: number;
  updated_at?: string;
}

export interface PutCloudBackupObjectInput {
  key: string;
  data: Buffer;
  contentType?: string;
}

export interface CloudBackupDestinationAdapter {
  kind: CloudBackupDestinationKind;
  id?: string;
  baseUri: string;
  status(prefix?: string): Promise<BackupDestinationStatus>;
  putObject(input: PutCloudBackupObjectInput): Promise<void>;
  getObject(key: string): Promise<Buffer>;
  listObjects(prefix: string): Promise<CloudBackupObject[]>;
  deleteObject(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
}

export function createCloudBackupDestination(config: OpenWikiBackupDestinationConfig): CloudBackupDestinationAdapter {
  if (config.kind === "s3" || config.kind === "minio") {
    return new S3BackupDestination(config, config.kind);
  }
  if (config.kind === "gcs") {
    return new GcsBackupDestination(config);
  }
  if (config.kind === "rclone") {
    return createRcloneBackupDestination(config);
  }
  throw new Error(`Backup destination '${config.id}' uses unsupported cloud kind '${config.kind}'.`);
}

export async function putVerifiedCloudBackupObject(
  adapter: CloudBackupDestinationAdapter,
  input: PutCloudBackupObjectInput,
): Promise<void> {
  const normalizedKey = normalizeBackupObjectKey(input.key);
  await adapter.putObject({ ...input, key: normalizedKey });
  const uploaded = await adapter.getObject(normalizedKey);
  if (!uploaded.equals(input.data)) {
    await adapter.deleteObject(normalizedKey).catch(() => undefined);
    throw new Error(`Backup destination '${adapter.id ?? adapter.kind}' uploaded a partial or corrupted object: ${normalizedKey}`);
  }
}

export function cloudBackupObjectUri(config: OpenWikiBackupDestinationConfig, key: string): string {
  const normalizedKey = normalizeObjectKey(key);
  if (config.kind === "s3" || config.kind === "minio") {
    return `s3://${requiredClean(config.bucket, "bucket")}/${normalizedKey}`;
  }
  if (config.kind === "gcs") {
    return `gs://${requiredClean(config.bucket, "bucket")}/${normalizedKey}`;
  }
  if (config.kind === "rclone") {
    return rcloneBackupObjectUri(config, normalizedKey);
  }
  throw new Error(`Backup destination '${config.id}' is not a cloud destination.`);
}

class S3BackupDestination implements CloudBackupDestinationAdapter {
  readonly kind: "s3" | "minio";
  readonly id?: string;
  readonly baseUri: string;

  constructor(
    private readonly config: OpenWikiBackupDestinationConfig,
    kind: "s3" | "minio",
  ) {
    this.kind = kind;
    this.id = config.id;
    this.baseUri = `s3://${requiredClean(config.bucket, "bucket")}`;
  }

  async status(prefix?: string): Promise<BackupDestinationStatus> {
    return backupDestinationStatusFromConfig(this.config, {
      providerIdentity: this.baseUri,
      ...(prefix === undefined ? {} : { configuredPrefix: prefix }),
    });
  }

  async putObject(input: PutCloudBackupObjectInput): Promise<void> {
    const settings = requiredS3Settings(this.config, this.kind);
    const headers: Record<string, string> = {};
    if (this.config.server_side_encryption !== undefined) {
      headers["x-amz-server-side-encryption"] = this.config.server_side_encryption;
    }
    if (this.config.kms_key_id !== undefined) {
      headers["x-amz-server-side-encryption-aws-kms-key-id"] = this.config.kms_key_id;
    }
    const response = await signedS3Fetch(settings, "PUT", s3ObjectUrl(settings, input.key), {
      body: input.data,
      contentType: input.contentType ?? "application/octet-stream",
      payloadHash: sha256Hex(input.data),
      extraHeaders: headers,
    });
    if (!response.ok) {
      throw providerError("S3-compatible backup upload failed", response);
    }
  }

  async getObject(key: string): Promise<Buffer> {
    const settings = requiredS3Settings(this.config, this.kind);
    const response = await signedS3Fetch(settings, "GET", s3ObjectUrl(settings, key), {
      payloadHash: "UNSIGNED-PAYLOAD",
    });
    if (!response.ok) {
      throw providerError("S3-compatible backup download failed", response);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  async listObjects(prefix: string): Promise<CloudBackupObject[]> {
    const settings = requiredS3Settings(this.config, this.kind);
    let continuationToken: string | undefined;
    const objects: CloudBackupObject[] = [];
    do {
      const url = s3BucketUrl(settings);
      url.searchParams.set("list-type", "2");
      url.searchParams.set("prefix", prefix);
      if (continuationToken !== undefined) {
        url.searchParams.set("continuation-token", continuationToken);
      }
      const response = await signedS3Fetch(settings, "GET", url, { payloadHash: "UNSIGNED-PAYLOAD" });
      if (!response.ok) {
        throw providerError("S3-compatible backup list failed", response);
      }
      const xml = await response.text();
      objects.push(...parseS3ListObjects(xml));
      continuationToken = xmlText(xml, "NextContinuationToken");
    } while (continuationToken !== undefined);
    return objects;
  }

  async deleteObject(key: string): Promise<void> {
    const settings = requiredS3Settings(this.config, this.kind);
    const response = await signedS3Fetch(settings, "DELETE", s3ObjectUrl(settings, key), {
      payloadHash: "UNSIGNED-PAYLOAD",
    });
    if (!response.ok && response.status !== 404) {
      throw providerError("S3-compatible backup delete failed", response);
    }
  }

  async deletePrefix(prefix: string): Promise<void> {
    await deleteBackupObjectPrefix({
      prefix,
      listObjects: (listPrefix) => this.listObjects(listPrefix),
      deleteObject: (key) => this.deleteObject(key),
    });
  }
}

class GcsBackupDestination implements CloudBackupDestinationAdapter {
  readonly kind = "gcs" as const;
  readonly id?: string;
  readonly baseUri: string;

  constructor(private readonly config: OpenWikiBackupDestinationConfig) {
    this.id = config.id;
    this.baseUri = `gs://${requiredClean(config.bucket, "bucket")}`;
  }

  async status(prefix?: string): Promise<BackupDestinationStatus> {
    return backupDestinationStatusFromConfig(this.config, {
      providerIdentity: this.baseUri,
      ...(prefix === undefined ? {} : { configuredPrefix: prefix }),
    });
  }

  async putObject(input: PutCloudBackupObjectInput): Promise<void> {
    const bucket = requiredClean(this.config.bucket, "bucket");
    const url = new URL(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o`);
    url.searchParams.set("uploadType", "media");
    url.searchParams.set("name", input.key);
    const headers: Record<string, string> = {
      "content-type": input.contentType ?? "application/octet-stream",
    };
    if (this.config.kms_key_name !== undefined) {
      headers["x-goog-encryption-kms-key-name"] = this.config.kms_key_name;
    }
    const response = await gcsFetch(this.config, url, {
      method: "POST",
      headers,
      body: input.data as unknown as BodyInit,
    });
    if (!response.ok) {
      throw providerError("GCS backup upload failed", response);
    }
  }

  async getObject(key: string): Promise<Buffer> {
    const response = await gcsFetch(this.config, gcsObjectUrl(this.config, key, true), { method: "GET" });
    if (!response.ok) {
      throw providerError("GCS backup download failed", response);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  async listObjects(prefix: string): Promise<CloudBackupObject[]> {
    const bucket = requiredClean(this.config.bucket, "bucket");
    let pageToken: string | undefined;
    const objects: CloudBackupObject[] = [];
    do {
      const url = new URL(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o`);
      url.searchParams.set("prefix", prefix);
      if (pageToken !== undefined) {
        url.searchParams.set("pageToken", pageToken);
      }
      const response = await gcsFetch(this.config, url, { method: "GET" });
      if (!response.ok) {
        throw providerError("GCS backup list failed", response);
      }
      const parsed = await response.json() as {
        items?: Array<{ name?: string; size?: string; updated?: string }>;
        nextPageToken?: string;
      };
      for (const item of parsed.items ?? []) {
        if (typeof item.name === "string") {
          objects.push({
            key: item.name,
            ...(item.size === undefined ? {} : { size: Number(item.size) }),
            ...(item.updated === undefined ? {} : { updated_at: item.updated }),
          });
        }
      }
      pageToken = parsed.nextPageToken;
    } while (pageToken !== undefined);
    return objects;
  }

  async deleteObject(key: string): Promise<void> {
    const response = await gcsFetch(this.config, gcsObjectUrl(this.config, key, false), { method: "DELETE" });
    if (!response.ok && response.status !== 404) {
      throw providerError("GCS backup delete failed", response);
    }
  }

  async deletePrefix(prefix: string): Promise<void> {
    await deleteBackupObjectPrefix({
      prefix,
      listObjects: (listPrefix) => this.listObjects(listPrefix),
      deleteObject: (key) => this.deleteObject(key),
    });
  }
}

interface S3Settings {
  endpointUrl: string;
  bucket: string;
  region: string;
  prefix?: string;
  forcePathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

function requiredS3Settings(config: OpenWikiBackupDestinationConfig, kind: "s3" | "minio"): S3Settings {
  const endpointUrl = cleanOptional(config.endpoint_url) ?? (kind === "s3" ? `https://s3.${cleanOptional(config.region) ?? "us-east-1"}.amazonaws.com` : undefined);
  if (endpointUrl === undefined) {
    throw new Error(`Backup destination '${config.id}' requires endpoint_url.`);
  }
  if (new URL(endpointUrl).protocol === "http:" && kind !== "minio" && config.allow_insecure_http !== true) {
    throw new Error(`Backup destination '${config.id}' uses insecure HTTP without allow_insecure_http=true.`);
  }
  const accessKeyIdEnv = requiredClean(config.access_key_id_env, "access_key_id_env");
  const secretAccessKeyEnv = requiredClean(config.secret_access_key_env, "secret_access_key_env");
  const sessionTokenEnv = cleanOptional(config.session_token_env);
  const accessKeyId = cleanOptional(process.env[accessKeyIdEnv]);
  const secretAccessKey = cleanOptional(process.env[secretAccessKeyEnv]);
  const sessionToken = sessionTokenEnv === undefined ? undefined : cleanOptional(process.env[sessionTokenEnv]);
  if (accessKeyId === undefined || secretAccessKey === undefined) {
    throw new Error(`Backup destination '${config.id}' is missing required S3 credential environment variables.`);
  }
  return {
    endpointUrl,
    bucket: requiredClean(config.bucket, "bucket"),
    region: cleanOptional(config.region) ?? "us-east-1",
    forcePathStyle: config.force_path_style ?? (kind === "minio" || Boolean(config.endpoint_url)),
    accessKeyId,
    secretAccessKey,
    ...(sessionToken === undefined ? {} : { sessionToken }),
  };
}

function s3BucketUrl(settings: S3Settings): URL {
  const endpoint = new URL(settings.endpointUrl);
  if (settings.forcePathStyle) {
    endpoint.pathname = joinUrlPath(endpoint.pathname, settings.bucket);
    return endpoint;
  }
  endpoint.hostname = `${settings.bucket}.${endpoint.hostname}`;
  return endpoint;
}

function s3ObjectUrl(settings: S3Settings, key: string): URL {
  const endpoint = s3BucketUrl(settings);
  endpoint.pathname = joinUrlPath(endpoint.pathname, ...normalizeObjectKey(key).split("/").map(encodeURIComponent));
  return endpoint;
}

async function signedS3Fetch(
  settings: S3Settings,
  method: "DELETE" | "GET" | "PUT",
  url: URL,
  options: { body?: Buffer; contentType?: string; payloadHash: string; extraHeaders?: Record<string, string> } = { payloadHash: "UNSIGNED-PAYLOAD" },
): Promise<Response> {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateScope = amzDate.slice(0, 8);
  const credentialScope = `${dateScope}/${settings.region}/s3/aws4_request`;
  const headers: Record<string, string> = {
    host: url.host,
    "x-amz-content-sha256": options.payloadHash,
    "x-amz-date": amzDate,
    ...(options.extraHeaders ?? {}),
  };
  if (options.contentType !== undefined) {
    headers["content-type"] = options.contentType;
  }
  if (options.body !== undefined) {
    headers["content-length"] = String(options.body.byteLength);
  }
  if (settings.sessionToken !== undefined) {
    headers["x-amz-security-token"] = settings.sessionToken;
  }
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers).sort().map((key) => `${key}:${headers[key]}\n`).join("");
  const canonicalQuery = [...url.searchParams.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  const canonicalRequest = [method, url.pathname, canonicalQuery, canonicalHeaders, signedHeaders, options.payloadHash].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");
  const signature = hmacHex(signingKey(settings.secretAccessKey, dateScope, settings.region, "s3"), stringToSign);
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${settings.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return fetch(url, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: options.body as unknown as BodyInit }),
  });
}

async function gcsFetch(config: OpenWikiBackupDestinationConfig, url: URL, init: RequestInit): Promise<Response> {
  const token = await gcsAccessToken(config);
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  return fetch(url, { ...init, headers });
}

async function gcsAccessToken(config: OpenWikiBackupDestinationConfig): Promise<string> {
  const envName = requiredClean(config.credentials_env, "credentials_env");
  const credentialPointer = cleanOptional(process.env[envName]);
  if (credentialPointer === undefined) {
    throw new Error(`Backup destination '${config.id}' is missing GCS credentials env ${envName}.`);
  }
  const raw = credentialPointer.trim().startsWith("{") ? credentialPointer : await fs.readFile(credentialPointer, "utf8");
  const credentials = JSON.parse(raw) as { client_email?: string; private_key?: string; token_uri?: string };
  if (!credentials.client_email || !credentials.private_key) {
    throw new Error(`Backup destination '${config.id}' has invalid GCS service-account credentials.`);
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  const assertion = jwtRs256(
    { alg: "RS256", typ: "JWT" },
    {
      iss: credentials.client_email,
      scope: "https://www.googleapis.com/auth/devstorage.read_write",
      aud: credentials.token_uri ?? "https://oauth2.googleapis.com/token",
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    },
    credentials.private_key,
  );
  const response = await fetch(credentials.token_uri ?? "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!response.ok) {
    throw providerError("GCS credential exchange failed", response);
  }
  const parsed = await response.json() as { access_token?: string };
  if (!parsed.access_token) {
    throw new Error("GCS credential exchange did not return an access token.");
  }
  return parsed.access_token;
}

function gcsObjectUrl(config: OpenWikiBackupDestinationConfig, key: string, media: boolean): URL {
  const bucket = requiredClean(config.bucket, "bucket");
  const url = new URL(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(normalizeObjectKey(key))}`);
  if (media) {
    url.searchParams.set("alt", "media");
  }
  return url;
}

function parseS3ListObjects(xml: string): CloudBackupObject[] {
  return [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].flatMap((match) => {
    const body = match[1] ?? "";
    const key = xmlText(body, "Key");
    if (key === undefined) {
      return [];
    }
    const size = xmlText(body, "Size");
    const updated = xmlText(body, "LastModified");
    return [{
      key,
      ...(size === undefined ? {} : { size: Number(size) }),
      ...(updated === undefined ? {} : { updated_at: updated }),
    }];
  });
}

function xmlText(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`).exec(xml);
  return match?.[1] === undefined ? undefined : xmlDecode(match[1]);
}

function xmlDecode(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function normalizeObjectKey(value: string): string {
  return normalizeBackupObjectKey(value);
}

function requiredClean(value: string | undefined, name: string): string {
  const cleaned = cleanOptional(value);
  if (cleaned === undefined) {
    throw new Error(`Backup destination is missing required ${name}.`);
  }
  return cleaned;
}

function cleanOptional(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function joinUrlPath(...parts: string[]): string {
  return "/" + parts.map((part) => part.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/");
}

function providerError(message: string, response: Response): Error {
  return new Error(`${message}: HTTP ${response.status} ${response.statusText}`);
}

function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmacHex(key: Buffer, value: string): string {
  return createHmac("sha256", key).update(value).digest("hex");
}

function signingKey(secret: string, date: string, region: string, service: string): Buffer {
  const dateKey = hmacBuffer(Buffer.from(`AWS4${secret}`, "utf8"), date);
  const regionKey = hmacBuffer(dateKey, region);
  const serviceKey = hmacBuffer(regionKey, service);
  return hmacBuffer(serviceKey, "aws4_request");
}

function hmacBuffer(key: Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function jwtRs256(header: Record<string, unknown>, payload: Record<string, unknown>, privateKey: string): string {
  const encodedHeader = base64Url(JSON.stringify(header));
  const encodedPayload = base64Url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(privateKey);
  return `${signingInput}.${base64Url(signature)}`;
}

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
