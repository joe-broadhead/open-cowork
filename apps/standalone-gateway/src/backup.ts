import type { StandaloneGatewayRepository } from "./repository.js";

export async function exportStandaloneGatewayBackup(repository: Pick<StandaloneGatewayRepository, "dashboardSnapshot">): Promise<Record<string, unknown>> {
  const snapshot = await repository.dashboardSnapshot(500);
  return {
    format: "open-cowork-standalone-gateway-backup-v1",
    exportedAt: new Date().toISOString(),
    sessions: snapshot.sessions,
    identities: snapshot.identities,
    jobs: snapshot.jobs,
    audits: snapshot.audits,
  };
}
