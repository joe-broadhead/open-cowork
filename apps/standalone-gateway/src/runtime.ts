import type { ChannelProvider, IncomingChannelMessage } from "@open-cowork/gateway-channel";

import type { StandaloneOpenCodeAdapter } from "./opencode.js";
import { canIdentityPrompt } from "./repository.js";
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
  const sessionQueues = new Map<string, Promise<void>>();

  function runSerialized<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = sessionQueues.get(key) || Promise.resolve();
    const run = previous.catch(() => undefined).then(action);
    const tracked = run.then(() => undefined, () => undefined);
    sessionQueues.set(key, tracked);
    void tracked.finally(() => {
      if (sessionQueues.get(key) === tracked) sessionQueues.delete(key);
    });
    return run;
  }

  return {
    async handleMessage(provider, providerConfig, message) {
      const text = message.text.trim();
      if (!text) return;
      const providerWorkspaceId = providerWorkspaceIdFromMessage(message);
      const externalThreadId = message.target.threadId || message.target.chatId;
      const sessionQueueKey = `${provider.id}\0${providerWorkspaceId || ""}\0${message.target.chatId}\0${externalThreadId}`;
      await runSerialized(sessionQueueKey, async () => {
        const identity = await repository.findChannelIdentity({
          provider: provider.id,
          externalUserId: message.sender.providerUserId,
          providerWorkspaceId,
        });
        if (!identity || !canIdentityPrompt(identity)) {
          await repository.recordAudit("standalone.prompt.denied", message.sender.providerUserId, {
            provider: provider.id,
            providerKind: provider.kind,
            channelBindingId: providerConfig.channelBindingId,
            providerWorkspaceId,
            reason: identity ? promptDenyReason(identity) : "identity_not_found",
            identityId: identity?.identityId,
            identityRole: identity?.role,
            identityStatus: identity?.status,
          });
          return;
        }
        const session = await repository.findOrCreateSession({
          provider: provider.id,
          providerKind: provider.kind,
          providerWorkspaceId,
          channelBindingId: providerConfig.channelBindingId,
          target: message.target,
          externalUserId: message.sender.providerUserId,
          text,
        });
        await repository.appendEvent({ sessionId: session.sessionId, type: "user.message", payload: { text, providerMessageId: message.providerMessageId } });
        let runtimeSession = session;
        try {
          if (!runtimeSession.opencodeSessionId) {
            runtimeSession = await repository.updateSessionRuntime({
              sessionId: session.sessionId,
              opencodeSessionId: (await opencode.createSession({ title: session.title })).opencodeSessionId,
              status: "running",
            });
          }
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
      });
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

function promptDenyReason(identity: { role: string; status: string }): string {
  if (identity.status !== "active") return "identity_disabled";
  return "role_not_allowed";
}

function providerWorkspaceIdFromMessage(message: IncomingChannelMessage): string | null {
  const raw = objectRecord(message.raw);
  return stringField(raw, "workspace_id")
    || stringField(raw, "workspaceId")
    || stringField(raw, "team_id")
    || stringField(objectRecord(raw.team), "id")
    || stringField(raw, "guild_id")
    || stringField(raw, "server_id")
    || null;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
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
