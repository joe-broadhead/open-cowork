import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenWikiBackupDestinationConfig } from "@openwiki/core";
import {
  backupDestinationStatusFromConfig,
  deleteBackupObjectPrefix,
  normalizeBackupObjectKey,
  normalizeBackupObjectPrefix,
  redactBackupDiagnosticText,
  type BackupDestinationStatus,
} from "./backup-contract.ts";
import type { CloudBackupDestinationAdapter, CloudBackupObject, PutCloudBackupObjectInput } from "./backup-destinations.ts";

interface RcloneObjectJson {
  Path?: string;
  Size?: number | string;
  ModTime?: string;
  IsDir?: boolean;
}

interface RcloneCommandResult {
  stdout: Buffer;
  stderr: Buffer;
}

const RCLONE_BINARY = "rclone";

export function createRcloneBackupDestination(config: OpenWikiBackupDestinationConfig): CloudBackupDestinationAdapter {
  return new RcloneBackupDestination(config);
}

export function rcloneBackupObjectUri(config: OpenWikiBackupDestinationConfig, normalizedKey: string): string {
  return `rclone://${encodeURIComponent(requiredRcloneRemote(config))}/${normalizedKey}`;
}

class RcloneBackupDestination implements CloudBackupDestinationAdapter {
  readonly kind = "rclone" as const;
  readonly id?: string;
  readonly baseUri: string;

  constructor(private readonly config: OpenWikiBackupDestinationConfig) {
    this.id = config.id;
    this.baseUri = `rclone://${encodeURIComponent(requiredRcloneRemote(config))}`;
  }

  async status(prefix?: string): Promise<BackupDestinationStatus> {
    return backupDestinationStatusFromConfig(this.config, {
      providerIdentity: this.baseUri,
      ...(prefix === undefined ? {} : { configuredPrefix: prefix }),
    });
  }

  async putObject(input: PutCloudBackupObjectInput): Promise<void> {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openwiki-rclone-upload-"));
    const tempFile = path.join(tempDir, "object");
    try {
      await fs.writeFile(tempFile, input.data);
      await runRclone(["copyto", tempFile, rclonePathForKey(this.config, input.key)]);
      const uploaded = await this.getObject(input.key);
      if (!uploaded.equals(input.data)) {
        await this.deleteObject(input.key).catch(() => undefined);
        throw new Error("Rclone backup upload verification failed: uploaded object did not match local bytes.");
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }

  async getObject(key: string): Promise<Buffer> {
    const result = await runRclone(["cat", rclonePathForKey(this.config, key)]);
    return result.stdout;
  }

  async listObjects(prefix: string): Promise<CloudBackupObject[]> {
    const normalizedPrefix = normalizeObjectPrefix(prefix);
    const exactObject = !prefix.replace(/\\/g, "/").endsWith("/");
    try {
      const result = await runRclone(["lsjson", rclonePathForPrefix(this.config, normalizedPrefix), "--recursive", "--files-only"]);
      const parsed = parseRcloneLsJson(result.stdout.toString("utf8"));
      if (exactObject) {
        return parsed.length === 0 ? [] : [{
          key: normalizedPrefix,
          ...rcloneObjectMetadata(parsed[0]),
        }];
      }
      return parsed.flatMap((object) => {
        const relativePath = typeof object.Path === "string" ? normalizeObjectPrefix(object.Path) : undefined;
        if (relativePath === undefined || object.IsDir === true) {
          return [];
        }
        return [{
          key: `${normalizedPrefix}/${relativePath}`,
          ...rcloneObjectMetadata(object),
        }];
      });
    } catch (error) {
      if (isRcloneNotFoundError(error)) {
        return [];
      }
      throw error;
    }
  }

  async deleteObject(key: string): Promise<void> {
    try {
      await runRclone(["deletefile", rclonePathForKey(this.config, key)]);
    } catch (error) {
      if (!isRcloneNotFoundError(error)) {
        throw error;
      }
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

function rclonePathForKey(config: OpenWikiBackupDestinationConfig, key: string): string {
  return rclonePathForPrefix(config, normalizeObjectKey(key));
}

function rclonePathForPrefix(config: OpenWikiBackupDestinationConfig, prefix: string): string {
  const remote = requiredRcloneRemote(config).replace(/\/+$/g, "");
  const normalizedPrefix = normalizeObjectPrefix(prefix);
  return `${remote}/${normalizedPrefix}`;
}

function requiredRcloneRemote(config: OpenWikiBackupDestinationConfig): string {
  const remote = requiredClean(config.remote, "remote");
  if (
    remote.includes("\0") ||
    /[\r\n]/u.test(remote) ||
    remote.startsWith("-") ||
    remote.includes("://") ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}:/.test(remote)
  ) {
    throw new Error(`Backup destination '${config.id}' requires a configured rclone remote such as drive:OpenWikiBackups.`);
  }
  return remote;
}

async function runRclone(args: string[]): Promise<RcloneCommandResult> {
  for (const arg of args) {
    if (arg.includes("\0")) {
      throw new Error("Rclone arguments must not contain NUL bytes.");
    }
  }
  return new Promise((resolve, reject) => {
    execFile(RCLONE_BINARY, args, { encoding: "buffer", maxBuffer: 256 * 1024 * 1024 }, (error, stdout, stderr) => {
      const normalizedStdout = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? "");
      const normalizedStderr = Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr ?? "");
      if (error !== null) {
        reject(rcloneCommandError(args[0] ?? "command", error, normalizedStderr));
        return;
      }
      resolve({ stdout: normalizedStdout, stderr: normalizedStderr });
    });
  });
}

function rcloneCommandError(command: string, error: Error & { code?: string | number | null }, stderr: Buffer): Error {
  if (error.code === "ENOENT") {
    return Object.assign(
      new Error("rclone executable was not found on PATH. Install rclone and configure a remote before using this backup destination."),
      { rcloneKind: "missing_binary" },
    );
  }
  const text = redactRcloneText(stderr.toString("utf8") || error.message);
  const kind = rcloneErrorKind(text);
  const firstLine = text.split(/\r?\n/u).find((line) => line.trim().length > 0)?.trim();
  const message =
    kind === "not_found"
      ? "rclone remote object was not found."
      : kind === "missing_remote"
        ? "rclone remote is missing or not configured."
        : kind === "auth"
          ? "rclone remote authentication failed."
          : kind === "quota"
            ? "rclone remote quota was exceeded."
            : kind === "rate_limit"
              ? "rclone remote is rate limited."
              : `rclone ${command} failed${firstLine === undefined ? "." : `: ${firstLine}`}`;
  return Object.assign(new Error(message), { rcloneKind: kind });
}

function rcloneErrorKind(text: string): "auth" | "missing_remote" | "not_found" | "quota" | "rate_limit" | "other" {
  if (/didn'?t find section|could not find section|no remotes found|not found in config|config file.*not found/iu.test(text)) {
    return "missing_remote";
  }
  if (/not found|object.*does not exist|directory not found|file not found|404/iu.test(text)) {
    return "not_found";
  }
  if (/auth|oauth|permission denied|unauthorized|forbidden|invalid grant|token/iu.test(text)) {
    return "auth";
  }
  if (/quota|insufficient storage|storage limit/iu.test(text)) {
    return "quota";
  }
  if (/rate limit|too many requests|429|throttle/iu.test(text)) {
    return "rate_limit";
  }
  return "other";
}

function isRcloneNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "rcloneKind" in error && error.rcloneKind === "not_found";
}

function redactRcloneText(value: string): string {
  return redactBackupDiagnosticText(value);
}

function parseRcloneLsJson(value: string): RcloneObjectJson[] {
  if (value.trim() === "") {
    return [];
  }
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("rclone lsjson returned an invalid response.");
  }
  return parsed.flatMap((item) => {
    if (typeof item !== "object" || item === null) {
      return [];
    }
    return [item as RcloneObjectJson];
  });
}

function rcloneObjectMetadata(object: RcloneObjectJson | undefined): Omit<CloudBackupObject, "key"> {
  if (object === undefined) {
    return {};
  }
  const size = object.Size === undefined ? undefined : Number(object.Size);
  return {
    ...(size !== undefined && Number.isFinite(size) ? { size } : {}),
    ...(typeof object.ModTime === "string" ? { updated_at: object.ModTime } : {}),
  };
}

function normalizeObjectKey(value: string): string {
  return normalizeBackupObjectKey(value);
}

function normalizeObjectPrefix(value: string): string {
  return normalizeBackupObjectPrefix(value);
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
