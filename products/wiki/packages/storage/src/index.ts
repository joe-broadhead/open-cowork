import { createHash, createHmac } from "node:crypto";
import { constants, promises as fs, type Stats } from "node:fs";
import path from "node:path";
import { atomicWriteFile, openWikiRepoRelativePath, type OpenWikiStorageBackend, type OpenWikiStorageConfig } from "@openwiki/core";

export {
  cloudBackupObjectUri,
  createCloudBackupDestination,
  putVerifiedCloudBackupObject,
  type CloudBackupDestinationAdapter,
  type CloudBackupDestinationKind,
  type CloudBackupObject,
  type PutCloudBackupObjectInput,
} from "./backup-destinations.ts";
export {
  backupDestinationCredentialState,
  backupDestinationStatusFromConfig,
  assertBackupObjectListConfinedToPrefix,
  deleteBackupObjectPrefix,
  defaultBackupDestinationCapabilities,
  listedBackupObjectKeyValidForPrefix,
  normalizeBackupObjectKey,
  normalizeBackupObjectPrefix,
  redactBackupDiagnosticText,
  type BackupCredentialState,
  type BackupDestinationCapabilities,
  type BackupDestinationDiagnostic,
  type BackupDestinationReadiness,
  type BackupDestinationStatus,
  type BackupLifecycleObject,
} from "./backup-contract.ts";

export interface PutObjectInput {
  data: string | Buffer;
  namespace?: string;
  extension?: string;
  mediaType?: string;
}

export interface StoredObject {
  kind: "object";
  backend: OpenWikiStorageBackend;
  path: string;
  content_hash: string;
  bytes: number;
  media_type?: string;
  content_addressed: true;
  bucket?: string;
  key?: string;
}

export interface ReadObjectResult {
  path: string;
  backend: OpenWikiStorageBackend;
  data: Buffer;
  bytes: number;
  truncated: boolean;
  media_type?: string;
  content_hash?: string;
}

export interface ContentStoreAdapter {
  backend: OpenWikiStorageBackend;
  put(input: PutObjectInput): Promise<StoredObject>;
  get(path: string, options?: { maxBytes?: number }): Promise<ReadObjectResult>;
}

export interface ContentStoreHealth {
  backend: OpenWikiStorageBackend;
  status: "ok" | "degraded" | "unsupported";
  path?: string;
  exists?: boolean;
  writable?: boolean;
  issues: string[];
}

const DEFAULT_INLINE_MAX_BYTES = 65536;
const DEFAULT_LOCAL_OBJECT_PATH = ".openwiki/objects";

interface DirectoryIdentity {
  dev: number;
  ino: number;
}

export function inlineMaxBytes(config: OpenWikiStorageConfig | undefined): number {
  return Math.max(config?.inline_max_bytes ?? DEFAULT_INLINE_MAX_BYTES, 0);
}

export function contentBuffer(data: string | Buffer): Buffer {
  return Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
}

export function sha256Buffer(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export async function createContentStore(root: string, config?: OpenWikiStorageConfig): Promise<ContentStoreAdapter> {
  const backend = config?.backend ?? "local";
  if (backend === "local") {
    return new LocalContentStore(root, config);
  }
  if (backend === "s3" || backend === "minio") {
    return new S3CompatibleContentStore(config, backend);
  }
  throw new Error(`OpenWiki storage backend '${backend}' is configured but not implemented in this runtime`);
}

export async function checkContentStoreHealth(root: string, config?: OpenWikiStorageConfig): Promise<ContentStoreHealth> {
  const backend = config?.backend ?? "local";
  if (backend === "s3" || backend === "minio") {
    const settings = s3Settings(config, backend);
    const issues = [
      ...(settings.endpointUrl === undefined ? ["S3-compatible storage requires runtime.storage.endpoint_url"] : []),
      ...(settings.bucket === undefined ? ["S3-compatible storage requires runtime.storage.bucket"] : []),
      ...(settings.accessKeyId === undefined ? [`Missing S3 access key env ${settings.accessKeyIdEnv}`] : []),
      ...(settings.secretAccessKey === undefined ? [`Missing S3 secret key env ${settings.secretAccessKeyEnv}`] : []),
    ];
    return {
      backend,
      status: issues.length === 0 ? "ok" : "degraded",
      ...(settings.endpointUrl === undefined || settings.bucket === undefined ? {} : { path: `${settings.endpointUrl.replace(/\/+$/, "")}/${settings.bucket}` }),
      issues,
    };
  }
  if (backend !== "local") {
    return { backend, status: "unsupported", issues: [`OpenWiki storage backend '${backend}' is configured but not implemented in this runtime`] };
  }
  const relativePath = normalizeRelativePath(config?.local_path ?? DEFAULT_LOCAL_OBJECT_PATH);
  const objectRoot = path.join(root, relativePath);
  const rootWritable = await pathWritable(root);
  const stats = await fs.stat(objectRoot).catch(() => undefined);
  const exists = Boolean(stats?.isDirectory());
  const writable = exists ? await pathWritable(objectRoot) : rootWritable;
  const issues = [
    ...(rootWritable ? [] : [`workspace root is not writable: ${root}`]),
    ...(exists || rootWritable ? [] : [`object store path does not exist and cannot be created: ${relativePath}`]),
    ...(writable ? [] : [`object store path is not writable: ${relativePath}`]),
  ];
  return {
    backend: "local",
    status: issues.length === 0 ? "ok" : "degraded",
    path: relativePath,
    exists,
    writable,
    issues,
  };
}

class LocalContentStore implements ContentStoreAdapter {
  readonly backend = "local" as const;

  constructor(
    private readonly root: string,
    private readonly config: OpenWikiStorageConfig | undefined,
  ) {}

  async put(input: PutObjectInput): Promise<StoredObject> {
    const buffer = contentBuffer(input.data);
    const hash = sha256Buffer(buffer);
    const extension = safeExtension(input.extension ?? "bin");
    const namespace = safePathSegment(input.namespace ?? "objects");
    const basePath = normalizeRelativePath(this.config?.local_path ?? DEFAULT_LOCAL_OBJECT_PATH);
    const relativePath = `${basePath}/${namespace}/sha256/${hash.slice(0, 2)}/${hash}.${extension}`;
    const target = safeLocalObjectPath(this.root, relativePath);
    const parentPath = path.dirname(target);
    const parentIdentity = await ensureLocalObjectDirectory(this.root, parentPath, relativePath);
    const existingTarget = await fs.lstat(target).catch((error: unknown) => {
      if (isMissingFileError(error)) {
        return undefined;
      }
      throw error;
    });
    if (existingTarget?.isSymbolicLink()) {
      throw new Error(`Object path must not include symbolic links: ${relativePath}`);
    }
    await assertDirectoryIdentity(parentPath, parentIdentity, relativePath);
    await atomicWriteFile(target, buffer);
    await assertDirectoryIdentity(parentPath, parentIdentity, relativePath);
    await assertRealPathWithinRoot(this.root, target, relativePath);
    return {
      kind: "object",
      backend: this.backend,
      path: relativePath,
      content_hash: `sha256:${hash}`,
      bytes: buffer.byteLength,
      content_addressed: true,
      ...(input.mediaType === undefined ? {} : { media_type: input.mediaType }),
    };
  }

  async get(objectPath: string, options: { maxBytes?: number } = {}): Promise<ReadObjectResult> {
    const filePath = safeLocalObjectPath(this.root, objectPath);
    await assertLocalObjectPathHasNoSymlinkComponents(this.root, filePath, objectPath);
    const parentPath = path.dirname(filePath);
    const parentIdentity = directoryIdentity(await fs.lstat(parentPath));
    const handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stats = await handle.stat();
    if (!stats.isFile()) {
      await handle.close();
      throw new Error(`Object path is not a file: ${objectPath}`);
    }
    await assertDirectoryIdentity(parentPath, parentIdentity, objectPath);
    await assertRealPathWithinRoot(this.root, filePath, objectPath);
    const maxBytes = boundedReadLimit(options.maxBytes);
    const readLimit = Math.min(stats.size, maxBytes);
    try {
      const buffer = Buffer.alloc(readLimit);
      const { bytesRead } = await handle.read(buffer, 0, readLimit, 0);
      const data = buffer.subarray(0, bytesRead);
      const expectedHash = localContentAddressedHash(objectPath);
      const contentHash = expectedHash === undefined || bytesRead < stats.size ? undefined : `sha256:${verifiedLocalHash(data, expectedHash, objectPath)}`;
      return {
        path: openWikiRepoRelativePath(this.root, filePath),
        backend: this.backend,
        data,
        bytes: stats.size,
        truncated: data.byteLength < stats.size,
        ...(contentHash === undefined ? {} : { content_hash: contentHash }),
      };
    } finally {
      await handle.close();
    }
  }
}

class S3CompatibleContentStore implements ContentStoreAdapter {
  constructor(
    private readonly config: OpenWikiStorageConfig | undefined,
    readonly backend: "s3" | "minio",
  ) {}

  async put(input: PutObjectInput): Promise<StoredObject> {
    const buffer = contentBuffer(input.data);
    const hash = sha256Buffer(buffer);
    const extension = safeExtension(input.extension ?? "bin");
    const namespace = safePathSegment(input.namespace ?? "objects");
    const settings = requiredS3Settings(this.config, this.backend);
    const key = s3ObjectKey(settings.prefix, namespace, hash, extension);
    const url = s3ObjectUrl(settings, key);
    const mediaType = input.mediaType ?? "application/octet-stream";
    const response = await signedS3Fetch(settings, "PUT", url, {
      body: buffer,
      contentType: mediaType,
      payloadHash: hash,
    });
    if (!response.ok) {
      throw new Error(`S3-compatible object write failed: HTTP ${response.status} ${response.statusText}`);
    }
    return {
      kind: "object",
      backend: this.backend,
      path: `s3://${settings.bucket}/${key}`,
      bucket: settings.bucket,
      key,
      content_hash: `sha256:${hash}`,
      bytes: buffer.byteLength,
      content_addressed: true,
      media_type: mediaType,
    };
  }

  async get(objectPath: string, options: { maxBytes?: number } = {}): Promise<ReadObjectResult> {
    const settings = requiredS3Settings(this.config, this.backend);
    const parsed = parseS3ObjectPath(objectPath, settings);
    const url = s3ObjectUrl(settings, parsed.key);
    const maxBytes = boundedReadLimit(options.maxBytes);
    const response = await signedS3Fetch(settings, "GET", url, {
      payloadHash: "UNSIGNED-PAYLOAD",
      range: `bytes=0-${Math.max(maxBytes - 1, 0)}`,
    });
    if (!response.ok) {
      throw new Error(`S3-compatible object read failed: HTTP ${response.status} ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const data = buffer.subarray(0, maxBytes);
    const contentRangeTotal = parseContentRangeTotal(response.headers.get("content-range"));
    const contentLength = parseNonNegativeInt(response.headers.get("content-length"));
    const bytes = contentRangeTotal ?? contentLength ?? buffer.byteLength;
    const truncated = contentRangeTotal === undefined && response.status === 206 ? data.byteLength >= maxBytes : data.byteLength < bytes;
    return {
      path: objectPath,
      backend: this.backend,
      data,
      bytes,
      truncated,
      ...(response.headers.get("content-type") === null ? {} : { media_type: response.headers.get("content-type") as string }),
      ...(truncated ? {} : { content_hash: `sha256:${sha256Buffer(buffer)}` }),
    };
  }
}

function boundedReadLimit(maxBytes: number | undefined): number {
  return Math.min(Math.max(maxBytes ?? 128 * 1024, 0), 1024 * 1024);
}

function safeExtension(extension: string): string {
  const cleaned = extension.trim().toLowerCase().replace(/^\.+/, "");
  if (!/^[a-z0-9][a-z0-9._-]{0,31}$/.test(cleaned)) {
    return "bin";
  }
  return cleaned;
}

function safePathSegment(segment: string): string {
  const cleaned = segment.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "objects";
}

function normalizeRelativePath(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!normalized || normalized.split("/").some((part) => part === "..")) {
    return DEFAULT_LOCAL_OBJECT_PATH;
  }
  return normalized;
}

async function pathWritable(target: string): Promise<boolean> {
  try {
    await fs.access(target, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

interface S3Settings {
  backend: "s3" | "minio";
  endpointUrl?: string;
  bucket?: string;
  region: string;
  prefix?: string;
  forcePathStyle: boolean;
  accessKeyIdEnv: string;
  secretAccessKeyEnv: string;
  sessionTokenEnv: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
}

function s3Settings(config: OpenWikiStorageConfig | undefined, backend: "s3" | "minio"): S3Settings {
  const accessKeyIdEnv = config?.access_key_id_env ?? "AWS_ACCESS_KEY_ID";
  const secretAccessKeyEnv = config?.secret_access_key_env ?? "AWS_SECRET_ACCESS_KEY";
  const sessionTokenEnv = config?.session_token_env ?? "AWS_SESSION_TOKEN";
  const endpointUrl = cleanOptional(config?.endpoint_url);
  const bucket = cleanOptional(config?.bucket);
  const prefix = cleanOptional(config?.prefix);
  const accessKeyId = cleanOptional(process.env[accessKeyIdEnv]);
  const secretAccessKey = cleanOptional(process.env[secretAccessKeyEnv]);
  const sessionToken = cleanOptional(process.env[sessionTokenEnv]);
  return {
    backend,
    region: cleanOptional(config?.region) ?? "us-east-1",
    forcePathStyle: config?.force_path_style ?? (backend === "minio" || Boolean(config?.endpoint_url)),
    accessKeyIdEnv,
    secretAccessKeyEnv,
    sessionTokenEnv,
    ...(endpointUrl === undefined ? {} : { endpointUrl }),
    ...(bucket === undefined ? {} : { bucket }),
    ...(prefix === undefined ? {} : { prefix }),
    ...(accessKeyId === undefined ? {} : { accessKeyId }),
    ...(secretAccessKey === undefined ? {} : { secretAccessKey }),
    ...(sessionToken === undefined ? {} : { sessionToken }),
  };
}

function requiredS3Settings(config: OpenWikiStorageConfig | undefined, backend: "s3" | "minio"): RequiredS3Settings {
  const settings = s3Settings(config, backend);
  const missing = [
    ...(settings.endpointUrl === undefined ? ["endpoint_url"] : []),
    ...(settings.bucket === undefined ? ["bucket"] : []),
    ...(settings.accessKeyId === undefined ? [settings.accessKeyIdEnv] : []),
    ...(settings.secretAccessKey === undefined ? [settings.secretAccessKeyEnv] : []),
  ];
  if (missing.length > 0) {
    throw new Error(`S3-compatible storage is missing required configuration: ${missing.join(", ")}`);
  }
  return settings as RequiredS3Settings;
}

interface RequiredS3Settings extends S3Settings {
  endpointUrl: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

function s3ObjectKey(prefix: string | undefined, namespace: string, hash: string, extension: string): string {
  return [prefix, namespace, "sha256", hash.slice(0, 2), `${hash}.${extension}`]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .map((part) => part.replace(/^\/+|\/+$/g, ""))
    .join("/");
}

function s3ObjectUrl(settings: RequiredS3Settings, key: string): URL {
  const endpoint = new URL(settings.endpointUrl);
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  if (settings.forcePathStyle) {
    endpoint.pathname = joinUrlPath(endpoint.pathname, settings.bucket, encodedKey);
    return endpoint;
  }
  endpoint.hostname = `${settings.bucket}.${endpoint.hostname}`;
  endpoint.pathname = joinUrlPath(endpoint.pathname, encodedKey);
  return endpoint;
}

function joinUrlPath(...parts: string[]): string {
  return "/" + parts.map((part) => part.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/");
}

async function signedS3Fetch(
  settings: RequiredS3Settings,
  method: "GET" | "PUT",
  url: URL,
  options: { body?: Buffer; contentType?: string; payloadHash: string; range?: string },
): Promise<Response> {
  const now = new Date();
  const amzDate = amzTimestamp(now);
  const dateScope = amzDate.slice(0, 8);
  const service = "s3";
  const credentialScope = `${dateScope}/${settings.region}/${service}/aws4_request`;
  const headers: Record<string, string> = {
    host: url.host,
    "x-amz-content-sha256": options.payloadHash,
    "x-amz-date": amzDate,
  };
  if (options.contentType !== undefined) {
    headers["content-type"] = options.contentType;
  }
  if (options.range !== undefined) {
    headers.range = options.range;
  }
  if (options.body !== undefined) {
    headers["content-length"] = String(options.body.byteLength);
  }
  if (settings.sessionToken !== undefined) {
    headers["x-amz-security-token"] = settings.sessionToken;
  }
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers).sort().map((key) => `${key}:${headers[key]}\n`).join("");
  const canonicalRequest = [
    method,
    url.pathname,
    url.searchParams.toString(),
    canonicalHeaders,
    signedHeaders,
    options.payloadHash,
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const signature = hmacHex(signingKey(settings.secretAccessKey, dateScope, settings.region, service), stringToSign);
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${settings.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const init: RequestInit = {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: options.body as unknown as BodyInit }),
  };
  return fetch(url, init);
}

function parseContentRangeTotal(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }
  const match = /^bytes\s+\d+-\d+\/(\d+)$/i.exec(value.trim());
  return match === null ? undefined : parseNonNegativeInt(match[1] ?? null);
}

function parseNonNegativeInt(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseS3ObjectPath(value: string, settings: RequiredS3Settings): { bucket: string; key: string } {
  if (value.startsWith("s3://")) {
    const parsed = new URL(value);
    const key = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
    if (!parsed.hostname || !key) {
      throw new Error(`Invalid S3 object path: ${value}`);
    }
    if (parsed.hostname !== settings.bucket) {
      throw new Error(`Invalid S3 object bucket: expected ${settings.bucket}`);
    }
    validateS3ObjectKey(key, settings, value);
    return { bucket: settings.bucket, key };
  }
  const key = value.replace(/^\/+/, "");
  validateS3ObjectKey(key, settings, value);
  return { bucket: settings.bucket, key };
}

function validateS3ObjectKey(key: string, settings: RequiredS3Settings, originalValue: string): void {
  if (!key || /[\u0000-\u001f\u007f]/u.test(key)) {
    throw new Error(`Invalid S3 object key: ${originalValue}`);
  }
  if (key.split("/").some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new Error(`Invalid S3 object key: ${originalValue}`);
  }
  const prefix = settings.prefix?.replace(/^\/+|\/+$/g, "");
  if (prefix !== undefined && prefix.length > 0 && key !== prefix && !key.startsWith(`${prefix}/`)) {
    throw new Error(`Invalid S3 object key outside configured prefix: ${originalValue}`);
  }
}

function cleanOptional(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function amzTimestamp(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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

function hmacHex(key: Buffer, value: string): string {
  return createHmac("sha256", key).update(value).digest("hex");
}

function safeLocalObjectPath(root: string, objectPath: string): string {
  if (path.isAbsolute(objectPath)) {
    throw new Error(`Object path escapes OpenWiki workspace: ${objectPath}`);
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, objectPath);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Object path escapes OpenWiki workspace: ${objectPath}`);
  }
  return resolved;
}

async function assertRealPathWithinRoot(root: string, existingPath: string, objectPath: string): Promise<void> {
  const realRoot = await fs.realpath(root);
  const realPath = await fs.realpath(existingPath);
  if (realPath !== realRoot && !realPath.startsWith(`${realRoot}${path.sep}`)) {
    throw new Error(`Object path escapes OpenWiki workspace: ${objectPath}`);
  }
}

async function ensureLocalObjectDirectory(root: string, directoryPath: string, objectPath: string): Promise<DirectoryIdentity> {
  const resolvedRoot = path.resolve(root);
  const relativePath = path.relative(resolvedRoot, directoryPath);
  if (!relativePath || relativePath === ".") {
    return directoryIdentity(await fs.lstat(resolvedRoot));
  }
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`Object path escapes OpenWiki workspace: ${objectPath}`);
  }

  let currentPath = resolvedRoot;
  for (const part of relativePath.split(path.sep)) {
    currentPath = path.join(currentPath, part);
    let stats: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stats = await fs.lstat(currentPath);
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
      await fs.mkdir(currentPath, { mode: 0o777 });
      stats = await fs.lstat(currentPath);
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`Object path must not include symbolic links: ${objectPath}`);
    }
    if (!stats.isDirectory()) {
      throw new Error(`Object parent path is not a directory: ${objectPath}`);
    }
  }
  await assertRealPathWithinRoot(resolvedRoot, directoryPath, objectPath);
  return directoryIdentity(await fs.lstat(directoryPath));
}

async function assertDirectoryIdentity(directoryPath: string, expected: DirectoryIdentity, objectPath: string): Promise<void> {
  const stats = await fs.lstat(directoryPath);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Object parent path changed during access: ${objectPath}`);
  }
  const actual = directoryIdentity(stats);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw new Error(`Object parent path changed during access: ${objectPath}`);
  }
}

function directoryIdentity(stats: Stats): DirectoryIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

async function assertLocalObjectPathHasNoSymlinkComponents(root: string, filePath: string, objectPath: string): Promise<void> {
  const resolvedRoot = path.resolve(root);
  const relativePath = path.relative(resolvedRoot, filePath);
  if (!relativePath || relativePath === "." || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`Object path escapes OpenWiki workspace: ${objectPath}`);
  }
  let currentPath = resolvedRoot;
  for (const part of relativePath.split(path.sep)) {
    currentPath = path.join(currentPath, part);
    const stats = await fs.lstat(currentPath);
    if (stats.isSymbolicLink()) {
      throw new Error(`Object path must not include symbolic links: ${objectPath}`);
    }
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

function localContentAddressedHash(objectPath: string): string | undefined {
  const fileName = path.posix.basename(objectPath.replace(/\\/g, "/"));
  const match = /^([a-f0-9]{64})\.[a-z0-9._-]+$/i.exec(fileName);
  return match?.[1]?.toLowerCase();
}

function verifiedLocalHash(data: Buffer, expectedHash: string, objectPath: string): string {
  const actual = sha256Buffer(data);
  if (actual !== expectedHash) {
    throw new Error(`Object content hash mismatch for ${objectPath}`);
  }
  return actual;
}
