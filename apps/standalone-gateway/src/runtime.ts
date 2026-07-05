import { chunkText } from "@open-cowork/gateway-channel";
import type { ChannelProvider, IncomingChannelMessage } from "@open-cowork/gateway-channel";

import type { StandaloneOpenCodeAdapter } from "./opencode.js";
import { canIdentityPrompt } from "./repository.js";
import type { StandaloneGatewayRepository, StandaloneGatewayLeaseRef } from "./repository.js";
import type { StandaloneGatewayJobRecord, StandaloneGatewayProviderConfig, StandaloneRuntimeEvent } from "./types.js";

export interface StandaloneGatewayRuntime {
  handleMessage(provider: ChannelProvider, providerConfig: StandaloneGatewayProviderConfig, message: IncomingChannelMessage): Promise<void>;
  runDueJobs(claimedBy: string, options?: { lease?: StandaloneGatewayLeaseRef | null; isActive?: () => boolean }): Promise<number>;
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

  async function runPromptJob(job: StandaloneGatewayJobRecord): Promise<void> {
    const text = stringField(job.payload, "text");
    if (!text) throw new Error("Prompt job payload is missing a non-empty \"text\" field.");
    const sessionId = job.sessionId;
    const opencodeSessionId = stringField(job.payload, "opencodeSessionId")
      || (await opencode.createSession({ title: text.slice(0, 80) })).opencodeSessionId;
    await opencode.prompt({
      opencodeSessionId,
      text,
      onEvent: async (event) => {
        if (sessionId) await appendRuntimeEvent(repository, sessionId, event);
      },
    });
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
          const assistantTexts: string[] = [];
          await opencode.prompt({
            opencodeSessionId: runtimeSession.opencodeSessionId || session.sessionId,
            text,
            onEvent: async (event) => {
              if (event.type === "assistant.message") {
                const assistantText = stringField(objectRecord(event.payload), "text");
                if (assistantText) assistantTexts.push(assistantText);
              }
              await appendRuntimeEvent(repository, session.sessionId, event);
            },
          });
          await repository.updateSessionRuntime({
            sessionId: session.sessionId,
            opencodeSessionId: runtimeSession.opencodeSessionId,
            status: "idle",
          });
          // Deliver the final assistant output back into the originating channel. Persisting the
          // event alone is not a reply — without this the appliance only ever answers via the
          // admin dashboard. Delivery failures are audited but never fail the prompt itself.
          await sendChannelReply({ repository, provider, session, message, text: coalesceAssistantText(assistantTexts) });
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
    async runDueJobs(claimedBy, options = {}) {
      let processed = 0;
      for (;;) {
        // Stop claiming the instant the daemon lease is lost (audit P1-G4) — the claim itself is
        // also lease-guarded, so a stale daemon can neither start a new job nor race a successor.
        if (options.isActive && !options.isActive()) break;
        const job = await repository.claimNextJob({ claimedBy, ttlMs: 30_000, lease: options.lease });
        if (!job) break;
        // Only "prompt" jobs have an execution path in the standalone appliance. Every other kind
        // must finish as failed with a descriptive reason — never as a silent "completed".
        if (job.kind !== "prompt") {
          await repository.recordAudit("standalone.job.unsupported", claimedBy, { jobId: job.jobId, kind: job.kind });
          await repository.finishJob({
            jobId: job.jobId,
            claimToken: job.claimToken || "",
            status: "failed",
            lastError: `Job kind "${job.kind}" is not implemented in the standalone gateway.`,
          });
          processed += 1;
          continue;
        }
        try {
          await repository.recordAudit("standalone.job.claimed", claimedBy, { jobId: job.jobId, kind: job.kind });
          await runPromptJob(job);
          await repository.finishJob({ jobId: job.jobId, claimToken: job.claimToken || "", status: "completed" });
        } catch (error) {
          await repository.finishJob({
            jobId: job.jobId,
            claimToken: job.claimToken || "",
            status: job.attemptCount >= 3 ? "dead" : "failed",
            lastError: error instanceof Error ? error.message : String(error),
          });
        }
        processed += 1;
      }
      return processed;
    },
  };
}

async function sendChannelReply(input: {
  repository: StandaloneGatewayRepository;
  provider: ChannelProvider;
  session: { sessionId: string };
  message: IncomingChannelMessage;
  text: string;
}): Promise<void> {
  const replyText = input.text.trim();
  if (!replyText || !input.message.target.chatId) return;
  const deliveryBase = `standalone:${input.session.sessionId}:${input.message.providerEventId || input.message.id}:reply`;
  try {
    const chunks = chunkText(replyText, input.provider.capabilities.maxTextLength);
    for (const [index, chunk] of chunks.entries()) {
      await input.provider.sendText(input.message.target, chunk, {
        deliveryId: chunks.length === 1 ? deliveryBase : `${deliveryBase}:chunk:${index + 1}`,
      });
    }
  } catch (error) {
    await input.repository.recordAudit("standalone.reply.failed", input.message.sender.providerUserId, {
      provider: input.provider.id,
      providerKind: input.provider.kind,
      sessionId: input.session.sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function coalesceAssistantText(parts: string[]): string {
  let merged = "";
  for (const part of parts) {
    const text = part.trim();
    if (!text) continue;
    if (!merged) {
      merged = text;
      continue;
    }
    // Streaming snapshots repeat earlier text — keep the superset instead of duplicating it.
    if (text.startsWith(merged)) {
      merged = text;
      continue;
    }
    if (merged.includes(text)) continue;
    merged = `${merged}\n\n${text}`;
  }
  return merged;
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
