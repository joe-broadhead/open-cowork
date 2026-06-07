import type { StandaloneGatewayRepository } from "./repository.js";
import type { StandaloneGatewayConfig, StandaloneGatewayRetentionResult } from "./types.js";

export interface StandaloneGatewayRetentionCutoffs {
  sessionCutoff: Date;
  artifactCutoff: Date;
  auditCutoff: Date;
  jobCutoff: Date;
}

export interface StandaloneGatewayRetentionLease {
  leaseId: string;
  ownerId: string;
  leaseToken: string;
}

export function describeStandaloneRetention(config: StandaloneGatewayConfig): string[] {
  return [
    `sessions:${config.retention.sessionDays}d`,
    `artifacts:${config.retention.artifactDays}d`,
    `audit:${config.retention.auditDays}d`,
    `jobs:${config.retention.jobDays}d`,
  ];
}

export function standaloneRetentionCutoffs(
  retention: StandaloneGatewayConfig["retention"],
  now = new Date(),
): StandaloneGatewayRetentionCutoffs {
  return {
    sessionCutoff: subtractDays(now, retention.sessionDays),
    artifactCutoff: subtractDays(now, retention.artifactDays),
    auditCutoff: subtractDays(now, retention.auditDays),
    jobCutoff: subtractDays(now, retention.jobDays),
  };
}

export async function runStandaloneGatewayRetention(input: {
  repository: Pick<StandaloneGatewayRepository, "pruneRetention">;
  config: StandaloneGatewayConfig;
  lease: StandaloneGatewayRetentionLease;
  now?: Date;
}): Promise<StandaloneGatewayRetentionResult | null> {
  return input.repository.pruneRetention({
    retention: input.config.retention,
    leaseId: input.lease.leaseId,
    ownerId: input.lease.ownerId,
    leaseToken: input.lease.leaseToken,
    now: input.now,
  });
}

function subtractDays(now: Date, days: number): Date {
  return new Date(now.getTime() - Math.max(1, Math.floor(days)) * 24 * 60 * 60 * 1000);
}
