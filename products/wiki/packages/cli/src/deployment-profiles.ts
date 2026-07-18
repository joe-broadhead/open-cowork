export type DeploymentProfileRequirement = "skip" | "warn" | "required";
export type DeploymentProfileName =
  | "local-personal"
  | "public-static"
  | "docker-private"
  | "hosted-enterprise"
  | "kubernetes-enterprise"
  | "aws-ecs-efs"
  | "gcp-gke"
  | "cloud-run-readmostly";

export interface DeploymentProfileDefinition {
  name: DeploymentProfileName;
  aliases: string[];
  status: string;
  trustBoundary: string;
  persistenceModel: string;
  backupModel: string;
  scalingPath: string;
  publicOrigin: DeploymentProfileRequirement;
  rateLimits: DeploymentProfileRequirement;
  imageDigest: DeploymentProfileRequirement;
  gitRemote: DeploymentProfileRequirement;
  postgres: DeploymentProfileRequirement;
  objectStorageBackup: DeploymentProfileRequirement;
  writeCoordinator: DeploymentProfileRequirement;
  operationalState: DeploymentProfileRequirement;
  mcpTokens: DeploymentProfileRequirement;
  staticArtifacts: boolean;
  previewWarning?: string;
}

export const DEPLOYMENT_PROFILE_NAMES: DeploymentProfileName[] = [
  "local-personal",
  "public-static",
  "docker-private",
  "hosted-enterprise",
  "kubernetes-enterprise",
  "aws-ecs-efs",
  "gcp-gke",
  "cloud-run-readmostly",
];

const DEPLOYMENT_PROFILES: Record<DeploymentProfileName, DeploymentProfileDefinition> = {
  "local-personal": {
    name: "local-personal",
    aliases: ["local", "personal"],
    status: "supported",
    trustBoundary: "local machine only",
    persistenceModel: "local Git workspace",
    backupModel: "workspace backup or private Git remote",
    scalingPath: "move to Docker or Kubernetes when shared",
    publicOrigin: "skip",
    rateLimits: "skip",
    imageDigest: "skip",
    gitRemote: "warn",
    postgres: "skip",
    objectStorageBackup: "skip",
    writeCoordinator: "skip",
    operationalState: "skip",
    mcpTokens: "skip",
    staticArtifacts: false,
  },
  "public-static": {
    name: "public-static",
    aliases: ["static", "github-pages"],
    status: "supported",
    trustBoundary: "static host with no server writes",
    persistenceModel: "generated static artifacts from Git",
    backupModel: "source Git repository; regenerate artifacts after restore",
    scalingPath: "re-export from CI or move private workflows to a server profile",
    publicOrigin: "warn",
    rateLimits: "skip",
    imageDigest: "skip",
    gitRemote: "warn",
    postgres: "skip",
    objectStorageBackup: "skip",
    writeCoordinator: "skip",
    operationalState: "skip",
    mcpTokens: "skip",
    staticArtifacts: true,
  },
  "docker-private": {
    name: "docker-private",
    aliases: ["docker", "compose", "local-team", "team", "umbrel"],
    status: "supported private profile",
    trustBoundary: "private network, trusted host, or SSO proxy",
    persistenceModel: "Docker volume or host path; optional Postgres/object storage",
    backupModel: "wiki volume, Git remote, Postgres, and object storage when enabled",
    scalingPath: "move to Kubernetes when web/worker/backends split",
    publicOrigin: "warn",
    rateLimits: "warn",
    imageDigest: "warn",
    gitRemote: "warn",
    postgres: "warn",
    objectStorageBackup: "warn",
    writeCoordinator: "warn",
    operationalState: "warn",
    mcpTokens: "warn",
    staticArtifacts: false,
  },
  "kubernetes-enterprise": {
    name: "kubernetes-enterprise",
    aliases: ["kubernetes", "enterprise", "k8s", "helm-kubernetes"],
    status: "supported enterprise profile",
    trustBoundary: "authenticated ingress/SSO",
    persistenceModel: "persistent volume, Postgres, and object storage",
    backupModel: "PV/Git remote, Postgres backups, object storage, and secrets",
    scalingPath: "separate web, worker, read, search, and queue backends",
    publicOrigin: "required",
    rateLimits: "required",
    imageDigest: "required",
    gitRemote: "required",
    postgres: "required",
    objectStorageBackup: "required",
    writeCoordinator: "required",
    operationalState: "required",
    mcpTokens: "required",
    staticArtifacts: false,
  },
  "hosted-enterprise": {
    name: "hosted-enterprise",
    aliases: ["hosted", "enterprise-hosted"],
    status: "supported hosted profile",
    trustBoundary: "authenticated SSO, reverse proxy, or private gateway",
    persistenceModel: "persistent POSIX Git workspace, Postgres, and object storage",
    backupModel: "Git remote, workspace snapshots, Postgres backups, object storage, and secrets",
    scalingPath: "separate web replicas, worker replicas, Postgres read/search/queue state, and shared operational state",
    publicOrigin: "required",
    rateLimits: "required",
    imageDigest: "required",
    gitRemote: "required",
    postgres: "required",
    objectStorageBackup: "required",
    writeCoordinator: "required",
    operationalState: "required",
    mcpTokens: "required",
    staticArtifacts: false,
  },
  "aws-ecs-efs": {
    name: "aws-ecs-efs",
    aliases: ["aws", "aws-reference"],
    status: "supported cloud reference",
    trustBoundary: "ALB plus OIDC or equivalent upstream auth",
    persistenceModel: "EFS for Git workspace; managed Postgres/object storage recommended",
    backupModel: "EFS backups, Git remote, Terraform state, Postgres/object storage, and secrets",
    scalingPath: "ECS service plus workers and external stores",
    publicOrigin: "required",
    rateLimits: "required",
    imageDigest: "required",
    gitRemote: "required",
    postgres: "warn",
    objectStorageBackup: "warn",
    writeCoordinator: "warn",
    operationalState: "warn",
    mcpTokens: "warn",
    staticArtifacts: false,
  },
  "gcp-gke": {
    name: "gcp-gke",
    aliases: ["gcp", "gke", "gcp-reference"],
    status: "supported cloud reference",
    trustBoundary: "GKE ingress plus IAP or equivalent SSO",
    persistenceModel: "Kubernetes persistent volume, Cloud SQL, and object storage",
    backupModel: "PV/disk snapshots, Git remote, Cloud SQL, object storage, and secrets",
    scalingPath: "Helm/Kustomize on GKE with separate runtime backends",
    publicOrigin: "required",
    rateLimits: "required",
    imageDigest: "required",
    gitRemote: "required",
    postgres: "required",
    objectStorageBackup: "required",
    writeCoordinator: "required",
    operationalState: "required",
    mcpTokens: "required",
    staticArtifacts: false,
  },
  "cloud-run-readmostly": {
    name: "cloud-run-readmostly",
    aliases: ["cloud-run", "cloud-run-read-mostly"],
    status: "preview/demo read-mostly",
    trustBoundary: "Cloud Run/IAP, private ingress, or static/read-only public surface",
    persistenceModel: "safe for writes only with a proper POSIX Git workspace",
    backupModel: "Git remote plus platform state; do not rely on Cloud Storage FUSE alone",
    scalingPath: "graduate writable workloads to GKE, a VM, or POSIX-backed runtime",
    publicOrigin: "required",
    rateLimits: "required",
    imageDigest: "required",
    gitRemote: "warn",
    postgres: "skip",
    objectStorageBackup: "warn",
    writeCoordinator: "skip",
    operationalState: "warn",
    mcpTokens: "warn",
    staticArtifacts: false,
    previewWarning: "Cloud Run with Cloud Storage FUSE is preview/read-mostly and is not a production writable Git recommendation.",
  },
};

export function deploymentProfileFor(value: string): DeploymentProfileDefinition {
  const normalized = value.trim().toLowerCase();
  for (const name of DEPLOYMENT_PROFILE_NAMES) {
    const profile = DEPLOYMENT_PROFILES[name];
    if (normalized === profile.name || profile.aliases.includes(normalized)) {
      return profile;
    }
  }
  throw new Error(`Invalid deployment profile '${value}'. Expected ${DEPLOYMENT_PROFILE_NAMES.join(", ")}.`);
}
