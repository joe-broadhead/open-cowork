import type {
  ChannelProviderId,
  ChannelProviderKind,
  ChannelTarget,
} from "@open-cowork/gateway-channel";

export type StandaloneGatewayStatus = "idle" | "running" | "blocked" | "failed" | "completed";
export type StandaloneGatewayIdentityRole = "owner" | "admin" | "member" | "approver" | "viewer";
export type StandaloneGatewayIdentityStatus = "active" | "disabled";
export type StandaloneGatewayEventType =
  | "session.created"
  | "user.message"
  | "assistant.message"
  | "tool.started"
  | "tool.completed"
  | "tool.failed"
  | "permission.requested"
  | "permission.resolved"
  | "question.asked"
  | "question.resolved"
  | "artifact.created"
  | "session.status"
  | "session.error";

export type StandaloneGatewayJobKind = "prompt" | "workflow" | "watch" | "team_task";
export type StandaloneGatewayJobStatus = "pending" | "claimed" | "running" | "completed" | "failed" | "dead";

export interface StandaloneGatewayProviderConfig {
  id: ChannelProviderId;
  kind: ChannelProviderKind;
  channelBindingId: string;
  enabled: boolean;
  credentials: Record<string, string>;
  settings: Record<string, unknown>;
}

export interface StandaloneGatewayConfig {
  productMode: "standalone";
  deploymentMode: "solo" | "team" | "enterprise";
  server: {
    host: string;
    port: number;
    adminToken: string;
    publicBaseUrl: string | null;
    trustProxyHeaders: boolean;
    trustedProxyCidrs: string[];
  };
  database: {
    url: string;
    ssl: boolean;
  };
  opencode: {
    baseUrl: string;
    allowPrivateDns: boolean;
    runtimeRoot: string | null;
  };
  retention: {
    sessionDays: number;
    artifactDays: number;
    auditDays: number;
  };
  providers: StandaloneGatewayProviderConfig[];
}

export interface StandaloneGatewaySessionRecord {
  sessionId: string;
  opencodeSessionId: string | null;
  title: string;
  status: StandaloneGatewayStatus;
  provider: ChannelProviderId;
  providerKind: ChannelProviderKind;
  providerWorkspaceId: string | null;
  channelBindingId: string;
  externalUserId: string;
  externalChatId: string;
  externalThreadId: string;
  lastEventSequence: number;
  createdAt: string;
  updatedAt: string;
}

export interface StandaloneGatewayEventRecord {
  eventId: string;
  sessionId: string;
  sequence: number;
  type: StandaloneGatewayEventType;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface StandaloneGatewayJobRecord {
  jobId: string;
  kind: StandaloneGatewayJobKind;
  status: StandaloneGatewayJobStatus;
  sessionId: string | null;
  payload: Record<string, unknown>;
  claimedBy: string | null;
  claimToken: string | null;
  claimExpiresAt: string | null;
  attemptCount: number;
  availableAt: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StandaloneGatewayDaemonLease {
  leaseId: string;
  ownerId: string;
  leaseToken: string;
  expiresAt: string;
  updatedAt: string;
}

export interface StandaloneGatewayAuditRecord {
  auditId: string;
  action: string;
  actor: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface StandaloneGatewayChannelIdentityRecord {
  identityId: string;
  provider: ChannelProviderId;
  externalUserId: string;
  providerWorkspaceId: string | null;
  role: StandaloneGatewayIdentityRole;
  status: StandaloneGatewayIdentityStatus;
  createdAt: string;
  updatedAt: string;
}

export interface StandaloneGatewayIdentityAuthorizationSummary {
  total: number;
  active: number;
  promptCapable: number;
}

export interface StandaloneGatewayDashboardSnapshot {
  generatedAt: string;
  sessions: StandaloneGatewaySessionRecord[];
  identities: StandaloneGatewayChannelIdentityRecord[];
  jobs: StandaloneGatewayJobRecord[];
  audits: StandaloneGatewayAuditRecord[];
}

export interface StandalonePromptInput {
  provider: ChannelProviderId;
  providerKind: ChannelProviderKind;
  providerWorkspaceId?: string | null;
  channelBindingId: string;
  target: ChannelTarget;
  externalUserId: string;
  text: string;
}

export interface StandaloneRuntimeEvent {
  type: StandaloneGatewayEventType;
  sessionId?: string | null;
  entityId?: string | null;
  payload?: Record<string, unknown>;
}
