import { chunkText } from "@open-cowork/gateway-channel";
import type { ChannelProvider, IncomingChannelMessage } from "@open-cowork/gateway-channel";
import {
  sanitizeRuntimeEventRecord,
  sanitizeRuntimeEventValue,
} from "@open-cowork/shared";

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
    const storedSession = sessionId ? await repository.getSession(sessionId) : null;
    if (sessionId && !storedSession) {
      throw new Error(`Prompt job references unknown standalone gateway session ${sessionId}.`);
    }
    const payloadSessionId = stringField(job.payload, "opencodeSessionId");
    if (
      payloadSessionId
      && storedSession?.opencodeSessionId
      && payloadSessionId !== storedSession.opencodeSessionId
    ) {
      throw new Error("Prompt job OpenCode session does not match its durable standalone session binding.");
    }
    let opencodeSessionId = storedSession?.opencodeSessionId || payloadSessionId;
    if (!opencodeSessionId) {
      if (!storedSession) {
        throw new Error("Prompt job requires a durable sessionId or an existing opencodeSessionId.");
      }
      const created = await opencode.createSession({ title: text.slice(0, 80) });
      const bound = await repository.updateSessionRuntime({
        sessionId: storedSession.sessionId,
        opencodeSessionId: created.opencodeSessionId,
        status: "running",
      });
      opencodeSessionId = bound.opencodeSessionId;
    } else if (storedSession) {
      await repository.updateSessionRuntime({
        sessionId: storedSession.sessionId,
        opencodeSessionId,
        status: "running",
      });
    }
    if (!opencodeSessionId) throw new Error("Prompt job could not establish a durable OpenCode session binding.");
    let runtimeFailure: string | null = null;
    try {
      await opencode.prompt({
        opencodeSessionId,
        admissionId: `standalone:job:${job.jobId}`,
        text,
        onEvent: async (event) => {
          runtimeFailure ||= runtimeFailureFromEvent(event);
          if (sessionId) await appendRuntimeEvent(repository, sessionId, event);
        },
      });
      if (runtimeFailure) throw new Error(runtimeFailure);
      if (storedSession) {
        await repository.updateSessionRuntime({
          sessionId: storedSession.sessionId,
          opencodeSessionId,
          status: "idle",
        });
      }
    } catch (error) {
      if (storedSession) {
        await repository.updateSessionRuntime({
          sessionId: storedSession.sessionId,
          opencodeSessionId,
          status: "failed",
        }).catch(() => undefined);
      }
      throw error;
    }
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
        let projectedRuntimeFailure = false;
        try {
          if (!runtimeSession.opencodeSessionId) {
            runtimeSession = await repository.updateSessionRuntime({
              sessionId: session.sessionId,
              opencodeSessionId: (await opencode.createSession({ title: session.title })).opencodeSessionId,
              status: "running",
            });
          }
          const assistantTexts: string[] = [];
          let runtimeFailure: string | null = null;
          await opencode.prompt({
            opencodeSessionId: runtimeSession.opencodeSessionId || session.sessionId,
            admissionId: `standalone:channel:${provider.id}:${providerWorkspaceId || ""}:${message.providerEventId || message.id}`,
            text,
            onEvent: async (event) => {
              runtimeFailure ||= runtimeFailureFromEvent(event);
              projectedRuntimeFailure ||= event.type === "session.error";
              if (event.type === "assistant.message") {
                const assistantText = stringField(objectRecord(event.payload), "text");
                if (assistantText) assistantTexts.push(assistantText);
              }
              await appendRuntimeEvent(repository, session.sessionId, event);
            },
          });
          if (runtimeFailure) throw new Error(runtimeFailure);
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
          const errorMessage = sanitizeRuntimeErrorMessage(error);
          if (!projectedRuntimeFailure) {
            await repository.appendEvent({
              sessionId: session.sessionId,
              type: "session.error",
              payload: { message: errorMessage },
            });
          }
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
            error: errorMessage,
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
        // Every claimed job gets a claim audit regardless of kind, so the audit trail is consistent
        // between the executable "prompt" path and the unsupported kinds below.
        await repository.recordAudit("standalone.job.claimed", claimedBy, { jobId: job.jobId, kind: job.kind });
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
    const chunks = splitReplyToLimit(replyText, input.provider.capabilities.maxTextLength);
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

// chunkText requires a limit >= 100. Real chat providers are far above that (Telegram 4096,
// etc.), but a provider that declares a sub-100 maxTextLength would otherwise make chunkText
// throw and silently drop every reply. For that case fall back to a plain content-preserving
// hard split at the provider's real limit so the answer is still delivered in valid chunks.
function splitReplyToLimit(text: string, maxTextLength: number): string[] {
  if (Number.isInteger(maxTextLength) && maxTextLength >= 100) {
    return chunkText(text, maxTextLength);
  }
  const limit = Math.max(1, Math.floor(maxTextLength));
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += limit) {
    chunks.push(text.slice(index, index + limit));
  }
  return chunks.length ? chunks : [text];
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
    payload: sanitizeRuntimeEventRecord({
      entityId: event.entityId,
      ...(event.payload || {}),
    }),
  });
}

function runtimeFailureFromEvent(event: StandaloneRuntimeEvent): string | null {
  if (event.type !== "session.error") return null;
  const payload = event.payload || {};
  return sanitizeRuntimeErrorMessage(
    payload.message
      ?? payload.error
      ?? "OpenCode runtime reported a terminal session failure.",
  );
}

function sanitizeRuntimeErrorMessage(error: unknown): string {
  const candidate = error instanceof Error ? error.message : String(error);
  const sanitized = sanitizeRuntimeEventValue(candidate);
  return typeof sanitized === "string" && sanitized
    ? sanitized
    : "OpenCode runtime reported a terminal session failure.";
}
