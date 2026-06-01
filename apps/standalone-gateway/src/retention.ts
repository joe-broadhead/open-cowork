import type { StandaloneGatewayConfig } from "./types.js";

export function describeStandaloneRetention(config: StandaloneGatewayConfig): string[] {
  return [
    `sessions:${config.retention.sessionDays}d`,
    `artifacts:${config.retention.artifactDays}d`,
    `audit:${config.retention.auditDays}d`,
  ];
}
