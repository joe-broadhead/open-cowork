import type { OpenWikiBackupDestinationConfig, OpenWikiConfig } from "@openwiki/core";
import {
  backupDestinationCredentialState,
  backupDestinationStatusFromConfig,
  redactBackupDiagnosticText,
  type BackupCredentialState,
  type BackupDestinationDiagnostic,
  type BackupDestinationReadiness,
} from "@openwiki/workflows";

export type BackupProviderState =
  | "configured"
  | "missing"
  | "expired"
  | "denied"
  | "quota_exceeded"
  | "rate_limited"
  | "unknown"
  | "unsupported";

export interface BackupCredentialRequirement {
  source: "none" | "env" | "external" | "credential_ref";
  name?: string;
  purpose: string;
  required: boolean;
  present: boolean;
}

export interface BackupCredentialLifecycle {
  rotation_mode: "not_required" | "manual" | "external";
  rotate_steps: string[];
  revoke_steps: string[];
  verify_steps: string[];
}

export interface BackupCredentialExplanation {
  id: string;
  kind: string;
  credential_state: BackupCredentialState;
  provider_state: BackupProviderState;
  requirements: BackupCredentialRequirement[];
  lifecycle: BackupCredentialLifecycle;
  diagnostics: BackupDestinationDiagnostic[];
}

interface BackupProviderReadinessCheck {
  name: string;
  status: "pass" | "warn" | "fail" | "skip";
  message: string;
  details?: Record<string, unknown>;
}

export function backupCredentialExplanation(
  destination: OpenWikiBackupDestinationConfig,
  input: {
    readiness?: BackupDestinationReadiness;
    diagnostics?: BackupDestinationDiagnostic[];
    error?: unknown;
  } = {},
): BackupCredentialExplanation {
  const credentialState = backupDestinationCredentialState(destination);
  const diagnostics = sanitizeBackupDiagnostics(input.diagnostics ?? []);
  return {
    id: destination.id,
    kind: destination.kind,
    credential_state: credentialState,
    provider_state: backupProviderState({
      credentialState,
      ...(input.readiness === undefined ? {} : { readiness: input.readiness }),
      diagnostics,
      ...(input.error === undefined ? {} : { error: input.error }),
    }),
    requirements: backupCredentialRequirements(destination),
    lifecycle: backupCredentialLifecycle(destination),
    diagnostics,
  };
}

export function backupProviderReadinessChecks(config: OpenWikiConfig): BackupProviderReadinessCheck[] {
  const backups = config.runtime?.backups;
  if (backups === undefined || backups.enabled === false || (backups.destinations ?? []).length === 0) {
    return [{
      name: "backup-provider-readiness",
      status: "skip",
      message: "No enabled backup destination is configured for provider readiness checks.",
    }];
  }
  return (backups.destinations ?? []).map((destination) => {
    const status = backupDestinationStatusFromConfig(destination, {
      ...(destination.prefix === undefined ? {} : { configuredPrefix: destination.prefix }),
    });
    const diagnostics = sanitizeBackupDiagnostics(status.diagnostics);
    const providerState = backupProviderState({
      credentialState: status.credential_state,
      readiness: status.readiness,
      diagnostics,
    });
    return {
      name: `backup-provider:${destination.id}`,
      status: providerDiagnosticStatus(providerState),
      message: providerReadinessMessage(destination, providerState),
      details: {
        id: destination.id,
        kind: destination.kind,
        readiness: status.readiness,
        provider_state: providerState,
        credential_state: status.credential_state,
        credential_requirements: backupCredentialRequirements(destination),
        diagnostics,
      },
    };
  });
}

export function backupCredentialRequirements(destination: OpenWikiBackupDestinationConfig): BackupCredentialRequirement[] {
  if (destination.kind === "local") {
    return [{
      source: "none",
      purpose: "Local-folder backups do not require provider credentials.",
      required: false,
      present: true,
    }];
  }
  if (destination.kind === "rclone") {
    return [{
      source: "external",
      ...(destination.remote === undefined ? {} : { name: destination.remote }),
      purpose: "rclone owns provider authentication and refresh tokens for this remote.",
      required: true,
      present: typeof destination.remote === "string" && destination.remote.trim().length > 0,
    }];
  }
  if (destination.credential_ref !== undefined) {
    return [{
      source: "credential_ref",
      name: redactCredentialRef(destination.credential_ref),
      purpose: "External secret reference resolved by the deployment environment.",
      required: true,
      present: true,
    }];
  }
  if (destination.kind === "s3" || destination.kind === "minio") {
    return [
      envRequirement(destination.access_key_id_env, "Access key id used only at runtime.", true),
      envRequirement(destination.secret_access_key_env, "Secret access key used only at runtime.", true),
      envRequirement(destination.session_token_env, "Optional session token used for temporary credentials.", false),
    ];
  }
  if (destination.kind === "gcs") {
    return [envRequirement(destination.credentials_env, "Environment variable pointing to GCS service-account JSON or JSON content.", true)];
  }
  return [{
    source: "external",
    purpose: `${destination.kind} is reserved or unsupported in this release.`,
    required: true,
    present: false,
  }];
}

export function backupCredentialLifecycle(destination: OpenWikiBackupDestinationConfig): BackupCredentialLifecycle {
  const verifySteps = [
    `openwiki backup status --destination ${destination.id} --json`,
    `openwiki backup verify latest --destination ${destination.id} --json`,
  ];
  if (destination.kind === "local") {
    return {
      rotation_mode: "not_required",
      rotate_steps: ["No provider credential rotation is required for a local-folder destination."],
      revoke_steps: ["No provider credential revoke step is required for a local-folder destination."],
      verify_steps: verifySteps,
    };
  }
  if (destination.kind === "rclone") {
    const remote = destination.remote ?? "<remote>:";
    return {
      rotation_mode: "external",
      rotate_steps: [
        `Rotate or reconnect the provider credential with rclone for ${remote}.`,
        `Run rclone lsd ${quoteShell(remote)} outside OpenWiki to confirm the remote works.`,
      ],
      revoke_steps: [
        "Revoke the old provider token, app password, or key in the provider console.",
        "Remove stale rclone config entries from the user or service account that runs OpenWiki.",
      ],
      verify_steps: verifySteps,
    };
  }
  if (destination.kind === "s3" || destination.kind === "minio") {
    return {
      rotation_mode: "manual",
      rotate_steps: [
        "Create a new least-privilege access key in the object-store provider.",
        "Update the configured access-key and secret-key environment variables in the deployment secret store.",
        "Restart or reload the OpenWiki process so the new environment is visible.",
      ],
      revoke_steps: [
        "Disable and delete the old object-store access key after status and verification pass.",
        "Check provider audit logs for denied or stale-key attempts.",
      ],
      verify_steps: verifySteps,
    };
  }
  if (destination.kind === "gcs") {
    return {
      rotation_mode: "manual",
      rotate_steps: [
        "Prefer workload identity where available; otherwise create a new service-account key with bucket-scoped access.",
        "Update the secret-backed environment variable or mounted credentials file referenced by credentials_env.",
        "Restart or reload OpenWiki so it reads the new credential.",
      ],
      revoke_steps: [
        "Delete the old GCS service-account key from Google Cloud IAM.",
        "Confirm no old key id is used in audit logs after rotation.",
      ],
      verify_steps: verifySteps,
    };
  }
  return {
    rotation_mode: "external",
    rotate_steps: [`${destination.kind} direct credential rotation is not automated in this release.`],
    revoke_steps: ["Revoke provider credentials in the provider console or external secret manager."],
    verify_steps: verifySteps,
  };
}

export function backupProviderState(input: {
  credentialState: BackupCredentialState;
  readiness?: BackupDestinationReadiness;
  diagnostics?: BackupDestinationDiagnostic[];
  error?: unknown;
}): BackupProviderState {
  if (input.credentialState === "unsupported" || input.readiness === "unsupported") {
    return "unsupported";
  }
  if (input.credentialState === "env_missing") {
    return "missing";
  }
  const text = [
    ...(input.diagnostics ?? []).flatMap((diagnostic) => [diagnostic.code, diagnostic.message]),
    input.error instanceof Error ? input.error.message : input.error === undefined ? "" : String(input.error),
  ].join("\n");
  if (/expired|invalid grant|token has expired|credential.*expired/iu.test(text)) {
    return "expired";
  }
  if (/denied|unauthorized|forbidden|auth|permission|invalid access key|signaturedoesnotmatch|authenticationfailed/iu.test(text)) {
    return "denied";
  }
  if (/quota|insufficient storage|storage limit|not enough space/iu.test(text)) {
    return "quota_exceeded";
  }
  if (/rate[_ -]?limit|too many requests|throttle|429/iu.test(text)) {
    return "rate_limited";
  }
  if (
    input.readiness === "ok" ||
    (
      input.readiness === undefined &&
      (input.credentialState === "not_required" || input.credentialState === "env_configured" || input.credentialState === "external")
    )
  ) {
    return "configured";
  }
  return "unknown";
}

export function sanitizeBackupDiagnostics(diagnostics: BackupDestinationDiagnostic[]): BackupDestinationDiagnostic[] {
  return diagnostics.map((diagnostic) => ({
    ...diagnostic,
    message: redactBackupDiagnosticText(diagnostic.message),
  }));
}

export function sanitizeBackupError(error: unknown): string {
  return redactBackupDiagnosticText(error instanceof Error ? error.message : String(error));
}

function providerDiagnosticStatus(providerState: BackupProviderState): BackupProviderReadinessCheck["status"] {
  if (providerState === "configured") {
    return "pass";
  }
  if (providerState === "missing" || providerState === "expired" || providerState === "denied") {
    return "fail";
  }
  return "warn";
}

function providerReadinessMessage(
  destination: OpenWikiBackupDestinationConfig,
  providerState: BackupProviderState,
): string {
  const label = `${destination.kind} backup destination ${destination.id}`;
  if (providerState === "configured") {
    return `${label} has usable credential configuration.`;
  }
  if (providerState === "missing") {
    return `${label} is missing required provider credentials.`;
  }
  if (providerState === "expired") {
    return `${label} credentials appear expired.`;
  }
  if (providerState === "denied") {
    return `${label} credentials are denied by the provider.`;
  }
  if (providerState === "quota_exceeded") {
    return `${label} appears blocked by provider quota or storage limits.`;
  }
  if (providerState === "rate_limited") {
    return `${label} appears rate-limited by the provider.`;
  }
  if (providerState === "unsupported") {
    return `${label} is reserved or unsupported in this release.`;
  }
  return `${label} provider readiness is unknown.`;
}

function envRequirement(name: string | undefined, purpose: string, required: boolean): BackupCredentialRequirement {
  return {
    source: "env",
    ...(name === undefined ? {} : { name }),
    purpose,
    required,
    present: name !== undefined && (process.env[name]?.trim() ?? "") !== "",
  };
}

function redactCredentialRef(value: string): string {
  const [prefix, suffix] = value.split(":", 2);
  if (prefix === undefined || suffix === undefined || suffix.length <= 4) {
    return "cred:<redacted>";
  }
  return `${prefix}:${suffix.slice(0, 2)}…${suffix.slice(-2)}`;
}

function quoteShell(value: string): string {
  return `"${value.replace(/["\\$`]/gu, "\\$&")}"`;
}
