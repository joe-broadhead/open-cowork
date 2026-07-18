import type { EventRecord, OpenWikiBackupSchedule, OpenWikiConfig } from "@openwiki/core";

interface BackupRehearsalDiagnosticCheck {
  name: string;
  status: "pass" | "warn" | "fail" | "skip";
  message: string;
  details?: Record<string, unknown>;
}

export function backupRehearsalDiagnostic(
  config: OpenWikiConfig,
  events: EventRecord[],
  nowMs: number = Date.now(),
): BackupRehearsalDiagnosticCheck {
  const backups = config.runtime?.backups;
  if (backups === undefined || backups.enabled === false || (backups.destinations ?? []).length === 0) {
    return {
      name: "restore-rehearsal",
      status: "skip",
      message: "No enabled backup destination is configured, so restore rehearsal evidence is not required.",
    };
  }
  const latest = events
    .filter((event) => event.type === "backup.rehearsed")
    .sort((left, right) => right.occurred_at.localeCompare(left.occurred_at))[0];
  if (latest === undefined) {
    return {
      name: "restore-rehearsal",
      status: "warn",
      message: "No restore rehearsal has been recorded. Run openwiki backup rehearse before relying on backups.",
    };
  }
  const rehearsedAt = Date.parse(latest.occurred_at);
  const ageSeconds = Number.isFinite(rehearsedAt) ? Math.max(0, Math.floor((nowMs - rehearsedAt) / 1000)) : undefined;
  const maxAgeSeconds = restoreRehearsalThresholdSeconds(backups.schedule);
  const details = {
    backup_id: backupIdFromEvent(latest),
    last_rehearsed_at: latest.occurred_at,
    target_root: latest.data?.target_root,
    validation_status: latest.data?.validation_status,
    ...(ageSeconds === undefined ? {} : { age_seconds: ageSeconds }),
    max_age_seconds: maxAgeSeconds,
  };
  if (ageSeconds !== undefined && ageSeconds > maxAgeSeconds) {
    return {
      name: "restore-rehearsal",
      status: "warn",
      message: "Latest restore rehearsal is stale for the configured backup cadence.",
      details,
    };
  }
  return {
    name: "restore-rehearsal",
    status: "pass",
    message: `Latest restore rehearsal completed at ${latest.occurred_at}.`,
    details,
  };
}

function restoreRehearsalThresholdSeconds(schedule: OpenWikiBackupSchedule | undefined): number {
  if (schedule === "hourly") {
    return 7 * 24 * 60 * 60;
  }
  if (schedule === "daily") {
    return 45 * 24 * 60 * 60;
  }
  if (schedule === "weekly") {
    return 120 * 24 * 60 * 60;
  }
  return 90 * 24 * 60 * 60;
}

function backupIdFromEvent(event: EventRecord): string | undefined {
  if (typeof event.record_id === "string" && event.record_id.trim().length > 0) {
    return event.record_id;
  }
  const backupId = event.data?.backup_id;
  return typeof backupId === "string" && backupId.trim().length > 0 ? backupId : undefined;
}
