import type { ChannelProvider, IncomingChannelMessage } from "@open-cowork/gateway-channel";

import type { StandaloneOpenCodeAdapter } from "./opencode.js";
import type { StandaloneGatewayRepository } from "./repository.js";
import type { StandaloneGatewayProviderConfig, StandaloneRuntimeEvent } from "./types.js";

export interface StandaloneGatewayRuntime {
  handleMessage(provider: ChannelProvider, providerConfig: StandaloneGatewayProviderConfig, message: IncomingChannelMessage): Promise<void>;
  runDueJobs(claimedBy: string): Promise<number>;
}

export function createStandaloneGatewayRuntime(input: {
  repository: StandaloneGatewayRepository;
  opencode: StandaloneOpenCodeAdapter;
}): StandaloneGatewayRuntime {
  const { repository, opencode } = input;
  return {
    async handleMessage(provider, providerConfig, message) {
      const text = message.text.trim();
      if (!text) return;
      const session = await repository.findOrCreateSession({
        provider: provider.id,
        providerKind: provider.kind,
        channelBindingId: providerConfig.channelBindingId,
        target: message.target,
        externalUserId: message.sender.providerUserId,
        text,
      });
      await repository.appendEvent({ sessionId: session.sessionId, type: "user.message", payload: { text, providerMessageId: message.providerMessageId } });
      const runtimeSession = session.opencodeSessionId
        ? session
        : await repository.updateSessionRuntime({
            sessionId: session.sessionId,
            opencodeSessionId: (await opencode.createSession({ title: session.title })).opencodeSessionId,
            status: "running",
          });
      try {
        await opencode.prompt({
          opencodeSessionId: runtimeSession.opencodeSessionId || session.sessionId,
          text,
          onEvent: (event) => appendRuntimeEvent(repository, session.sessionId, event),
        });
        await repository.updateSessionRuntime({
          sessionId: session.sessionId,
          opencodeSessionId: runtimeSession.opencodeSessionId,
          status: "idle",
        });
        await repository.recordAudit("standalone.prompt", message.sender.providerUserId, {
          provider: provider.id,
          providerKind: provider.kind,
          channelBindingId: providerConfig.channelBindingId,
          sessionId: session.sessionId,
        });
      } catch (error) {
        await repository.appendEvent({
          sessionId: session.sessionId,
          type: "session.error",
          payload: { message: error instanceof Error ? error.message : String(error) },
        });
        await repository.updateSessionRuntime({
          sessionId: session.sessionId,
          opencodeSessionId: runtimeSession.opencodeSessionId,
          status: "failed",
        });
        await repository.recordAudit("standalone.prompt.failed", message.sender.providerUserId, {
          provider: provider.id,
          providerKind: provider.kind,
          channelBindingId: providerConfig.channelBindingId,
          sessionId: session.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
    async runDueJobs(claimedBy) {
      let processed = 0;
      for (;;) {
        const job = await repository.claimNextJob({ claimedBy, ttlMs: 30_000 });
        if (!job) break;
        try {
          await repository.recordAudit("standalone.job.claimed", claimedBy, { jobId: job.jobId, kind: job.kind });
          await repository.finishJob({ jobId: job.jobId, claimToken: job.claimToken || "", status: "completed" });
          processed += 1;
        } catch (error) {
          await repository.finishJob({
            jobId: job.jobId,
            claimToken: job.claimToken || "",
            status: job.attemptCount >= 3 ? "dead" : "failed",
            lastError: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return processed;
    },
  };
}

async function appendRuntimeEvent(repository: StandaloneGatewayRepository, sessionId: string, event: StandaloneRuntimeEvent): Promise<void> {
  await repository.appendEvent({
    sessionId,
    type: event.type,
    payload: {
      entityId: event.entityId,
      ...(event.payload || {}),
    },
  });
}
