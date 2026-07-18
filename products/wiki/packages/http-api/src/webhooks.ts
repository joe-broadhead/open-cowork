import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { OpenWikiValidationError } from "@openwiki/core";
import { optionalBooleanBody } from "./request.ts";
import type { HttpPolicyOptions, HttpRouteResult } from "./types.ts";
import { createRun } from "@openwiki/jobs";
import { appendEvent } from "@openwiki/repo";
import { firstHeader } from "./http-headers.ts";

type WebhookProvider = "github" | "gitlab";
export type WebhookRunType = "index.rebuild" | "static.export" | "lint";

export async function receiveWebhook(
  root: string,
  provider: WebhookProvider,
  params: Record<string, unknown>,
  policy: HttpPolicyOptions,
  context: { headers?: IncomingHttpHeaders; rawBody?: string } = {},
): Promise<HttpRouteResult> {
  verifyWebhookSignature(provider, context);
  const actorId = policy.actorId ?? "actor:system:webhook";
  const event = await appendEvent(root, {
    type: `webhook.${provider}.received`,
    actor_id: actorId,
    operation: "wiki.receive_webhook",
    record_type: "webhook",
    data: webhookEventData(provider, params),
  });
  const enqueue = optionalBooleanBody(params, "enqueue") ?? true;
  if (!enqueue) {
    return {
      status: 202,
      body: {
        provider,
        event,
        run: null,
      },
    };
  }

  const runType = webhookRunType(params);
  const run = await createRun({
    root,
    runType,
    actorId,
    input: {
      provider,
      event_id: event.id,
      webhook_event: webhookEventName(provider, params),
      repository: webhookRepository(provider, params),
      ref: stringMetadata(params, "ref"),
    },
  });
  return {
    status: 202,
    body: {
      provider,
      event,
      run,
    },
  };
}

function verifyWebhookSignature(provider: WebhookProvider, context: { headers?: IncomingHttpHeaders; rawBody?: string }): void {
  const secret = webhookSecret(provider);
  if (secret === undefined) {
    return;
  }
  if (provider === "github") {
    const signature = firstHeader(context.headers?.["x-hub-signature-256"]);
    if (signature === undefined || !validGitHubSignature(context.rawBody ?? "", secret, signature)) {
      throw new OpenWikiValidationError("GitHub webhook signature verification failed");
    }
    return;
  }
  const token = firstHeader(context.headers?.["x-gitlab-token"]);
  if (!timingSafeStringEquals(token, secret)) {
    throw new OpenWikiValidationError("GitLab webhook token verification failed");
  }
}

function webhookSecret(provider: WebhookProvider): string | undefined {
  const value = provider === "github" ? process.env.OPENWIKI_WEBHOOK_GITHUB_SECRET : process.env.OPENWIKI_WEBHOOK_GITLAB_SECRET;
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function validGitHubSignature(rawBody: string, secret: string, signature: string): boolean {
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  return timingSafeStringEquals(signature, expected);
}

function timingSafeStringEquals(left: string | undefined, right: string): boolean {
  if (left === undefined) {
    return false;
  }
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function webhookProviderFromPath(pathname: string): WebhookProvider | undefined {
  if (pathname === "/api/v1/webhooks/github") {
    return "github";
  }
  if (pathname === "/api/v1/webhooks/gitlab") {
    return "gitlab";
  }
  return undefined;
}

export function webhookRunType(params: Record<string, unknown>): WebhookRunType {
  const value = params.run_type;
  if (value === undefined) {
    return "index.rebuild";
  }
  if (value === "index.rebuild" || value === "static.export" || value === "lint") {
    return value;
  }
  throw new Error("Expected webhook run_type to be index.rebuild, static.export, or lint");
}

function webhookEventData(provider: WebhookProvider, params: Record<string, unknown>): Record<string, unknown> {
  return {
    provider,
    event: webhookEventName(provider, params),
    delivery_id: stringMetadata(params, "delivery_id") ?? stringMetadata(params, "delivery"),
    repository: webhookRepository(provider, params),
    ref: stringMetadata(params, "ref"),
    sha: stringMetadata(params, "after") ?? stringMetadata(params, "checkout_sha"),
    action: stringMetadata(params, "action") ?? stringMetadata(params, "object_kind"),
    sender: webhookSender(provider, params),
  };
}

function webhookEventName(provider: WebhookProvider, params: Record<string, unknown>): string {
  const explicit = stringMetadata(params, "event");
  if (explicit) {
    return explicit;
  }
  return provider === "github" ? "push" : stringMetadata(params, "object_kind") ?? "push";
}

function webhookRepository(provider: WebhookProvider, params: Record<string, unknown>): string | undefined {
  if (provider === "github") {
    const repository = objectMetadata(params, "repository");
    return stringMetadata(repository, "full_name") ?? stringMetadata(params, "repository");
  }
  const project = objectMetadata(params, "project");
  return stringMetadata(project, "path_with_namespace") ?? stringMetadata(params, "project");
}

function webhookSender(provider: WebhookProvider, params: Record<string, unknown>): string | undefined {
  if (provider === "github") {
    return stringMetadata(objectMetadata(params, "sender"), "login");
  }
  return stringMetadata(params, "user_username") ?? stringMetadata(params, "user_name");
}

function objectMetadata(params: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = params[key];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function stringMetadata(params: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = params?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
