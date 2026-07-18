import type { InboxItemRecord, InboxProcessingFailureCategory } from "@openwiki/core";

export interface InboxProcessingFailureDetail {
  category: InboxProcessingFailureCategory;
  message: string;
  retryable: boolean;
  next_action: string;
  next_retry_at?: string;
}

export class InboxProcessingError extends Error {
  readonly detail: InboxProcessingFailureDetail;

  constructor(detail: InboxProcessingFailureDetail) {
    super(detail.message);
    this.name = "InboxProcessingError";
    this.detail = detail;
  }
}

export function failureDetail(
  category: InboxProcessingFailureCategory,
  message: string,
  item: InboxItemRecord,
): InboxProcessingFailureDetail {
  const retryable = retryableInboxFailure(category);
  return {
    category,
    message,
    retryable,
    next_action: nextInboxFailureAction(category, item),
    ...(retryable ? { next_retry_at: nextInboxRetryAt(item) } : {}),
  };
}

export function inboxFailureFromError(error: unknown, item: InboxItemRecord): InboxProcessingFailureDetail {
  if (error instanceof InboxProcessingError) {
    return error.detail;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/not authorized|requires|permission|visible/i.test(message)) {
    return failureDetail("permission_denied", message, item);
  }
  return failureDetail("unknown_internal_error", message, item);
}

function retryableInboxFailure(category: InboxProcessingFailureCategory): boolean {
  return category === "payload_unavailable" || category === "provider_unavailable" || category === "provider_timeout" || category === "sync_failed" || category === "unknown_internal_error";
}

function nextInboxFailureAction(category: InboxProcessingFailureCategory, item: InboxItemRecord): string {
  switch (category) {
    case "duplicate":
      return "Inspect the linked source or retry with force when a distinct source is required.";
    case "validation_failed":
      return "Fix the inbox payload or metadata, then retry the item.";
    case "payload_unavailable":
      return item.payload === undefined ? "Attach or restore the raw payload, then retry." : `Restore payload ${item.payload.path}, then retry.`;
    case "permission_denied":
      return "Grant the processing actor maintainer access to the target Space, then retry.";
    case "provider_unavailable":
      return "Check the processor/provider health, then retry.";
    case "provider_timeout":
      return "Increase the provider timeout or retry when the provider is responsive.";
    case "proposal_validation_failed":
      return "Review the proposed output, fix validation errors, then retry.";
    case "sync_failed":
      return "Inspect sync credentials and retry after the remote is healthy.";
    case "unknown_internal_error":
      return "Inspect the run log and retry after addressing the underlying error.";
  }
}

function nextInboxRetryAt(item: InboxItemRecord): string {
  const attempt = Math.max(item.processing?.attempt_count ?? 0, item.processing?.retry_count ?? 0, 0);
  const delaySeconds = Math.min(60 * 60, 2 ** Math.min(attempt, 8) * 30);
  return new Date(Date.now() + delaySeconds * 1000).toISOString();
}
