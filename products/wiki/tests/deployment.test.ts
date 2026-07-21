import { readdir, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { objectStorageBackupDiagnostic, postgresBackupDiagnostic, postgresDiagnostic } from "../packages/cli/src/commands/doctor.ts";

const execFileAsync = promisify(execFile);

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

test("hosted backup diagnostics require provider backup evidence", () => {
  assert.equal(postgresBackupDiagnostic(false, { DATABASE_URL: "postgres://openwiki:secret@127.0.0.1:5432/openwiki" }).status, "warn");
  assert.equal(
    postgresBackupDiagnostic(false, {
      DATABASE_URL: "postgres://openwiki:secret@127.0.0.1:5432/openwiki",
      OPENWIKI_POSTGRES_BACKUP_CONFIGURED: "1",
    }).status,
    "pass",
  );
  assert.equal(objectStorageBackupDiagnostic({ backend: "s3", bucket: "captures" }, {}).status, "warn");
  assert.equal(objectStorageBackupDiagnostic({ backend: "s3", bucket: "captures" }, {}, "required").status, "fail");
  assert.equal(objectStorageBackupDiagnostic(undefined, {}, "required").status, "fail");
  assert.equal(
    objectStorageBackupDiagnostic(
      { backend: "s3", bucket: "captures" },
      { OPENWIKI_OBJECT_STORAGE_BACKUP_CONFIGURED: "1" },
    ).status,
    "pass",
  );
});

test("hosted Postgres diagnostic fails closed when database URL is absent", async () => {
  const oldDatabaseUrl = process.env.DATABASE_URL;
  const oldOpenWikiDatabaseUrl = process.env.OPENWIKI_DATABASE_URL;
  try {
    delete process.env.DATABASE_URL;
    delete process.env.OPENWIKI_DATABASE_URL;
    const check = await postgresDiagnostic(process.cwd(), "required");
    assert.equal(check.name, "postgres");
    assert.equal(check.status, "fail");
    assert.match(check.message, /requires OPENWIKI_DATABASE_URL or DATABASE_URL/);
  } finally {
    restoreEnv("DATABASE_URL", oldDatabaseUrl);
    restoreEnv("OPENWIKI_DATABASE_URL", oldOpenWikiDatabaseUrl);
  }
});

test("deployment docs command references match manifests and CLI setup modes", async () => {
  const result = await execFileAsync(process.execPath, ["--no-warnings", "scripts/openwiki-validate-deploy-docs.mjs"], {
    cwd: process.cwd(),
  });
  assert.match(result.stdout, /Deployment docs validation passed/);
});

test("deployment artifacts reference the implemented OpenWiki server", async () => {
  const dockerfile = await readFile("Dockerfile", "utf8");
  assert.match(dockerfile, /node:24-bookworm-slim@sha256:/);
  assert.match(dockerfile, /AS base/);
  assert.match(dockerfile, /AS deps/);
  assert.match(dockerfile, /AS runtime/);
  assert.match(dockerfile, /ENV NODE_ENV=production/);
  assert.match(dockerfile, /Keep package installation reproducible against the pinned base digest/);
  assert.doesNotMatch(dockerfile, /apt-get upgrade -y/);
  assert.match(dockerfile, /ca-certificates git gosu openssh-client/);
  assert.match(dockerfile, /rm -rf \/usr\/local\/lib\/node_modules\/npm \/usr\/local\/bin\/npm \/usr\/local\/bin\/npx/);
  assert.match(dockerfile, /gosu/);
  assert.match(dockerfile, /COREPACK_HOME=\/home\/node\/\.cache\/node\/corepack/);
  assert.match(dockerfile, /corepack prepare pnpm@11\.9\.0 --activate/);
  assert.match(dockerfile, /pnpm install --frozen-lockfile --prod=false/);
  assert.match(dockerfile, /CI=true pnpm install --frozen-lockfile --prod/);
  assert.match(dockerfile, /chown -R node:node \/data \/app "\$PNPM_HOME" \/home\/node\/\.cache/);
  assert.match(dockerfile, /USER node/);
  assert.match(dockerfile, /HEALTHCHECK/);
  assert.match(dockerfile, /\/readyz/);
  assert.match(dockerfile, /pnpm build:web/);
  assert.match(dockerfile, /deploy\/docker\/entrypoint\.sh/);
  assert.doesNotMatch(dockerfile, /COPY \. \./);
  assert.match(dockerfile, /COPY packages \.\/packages/);
  assert.match(dockerfile, /COPY schemas \.\/schemas/);
  assert.match(dockerfile, /COPY templates \.\/templates/);
  assert.match(dockerfile, /COPY integrations \.\/integrations/);
  assert.match(dockerfile, /COPY deploy\/docker \.\/deploy\/docker/);

  const dockerignore = await readFile(".dockerignore", "utf8");
  assert.match(dockerignore, /artifacts/);
  assert.match(dockerignore, /site/);
  assert.match(dockerignore, /packages\/web\/assets/);
  assert.match(dockerignore, /packages\/web\/preview/);
  assert.match(dockerignore, /\.env\.\*/);
  assert.match(dockerignore, /\*\.sqlite3/);

  const entrypoint = await readFile("deploy/docker/entrypoint.sh", "utf8");
  assert.match(entrypoint, /OPENWIKI_SKIP_VOLUME_CHOWN/);
  assert.match(entrypoint, /chown -R "\$APP_USER:\$APP_GROUP" "\$ROOT"/);
  assert.match(entrypoint, /gosu "\$APP_USER" sh "\$0" "\$@"/);
  assert.match(entrypoint, /"\$1" != "serve"/);
  assert.match(entrypoint, /openwiki_cli\(\)/);
  assert.match(entrypoint, /node --no-warnings --import tsx \/app\/packages\/cli\/src\/main\.ts "\$@"/);
  assert.match(entrypoint, /openwiki_cli init "\$ROOT" --title "\$TITLE"/);
  assert.match(entrypoint, /src\/main\.ts --root "\$ROOT" serve/);
  assert.match(entrypoint, /db sync-postgres/);
  assert.match(entrypoint, /OPENWIKI_ROLE/);
  assert.match(entrypoint, /OPENWIKI_ROLE process-wide elevation is only allowed when OPENWIKI_HOST is loopback/);
  assert.match(entrypoint, /OPENWIKI_BOOTSTRAP_MODE/);
  assert.match(entrypoint, /OPENWIKI_GIT_REMOTE_URL/);
  assert.match(entrypoint, /OPENWIKI_ALLOW_LOCAL_GIT_REMOTE/);
  assert.match(entrypoint, /git_safe\(\)/);
  assert.match(entrypoint, /GIT_TERMINAL_PROMPT=0 git -c protocol\.ext\.allow=never -c protocol\.file\.allow=user/);
  assert.match(entrypoint, /validate_git_remote_url "\$GIT_REMOTE_URL"/);
  assert.match(entrypoint, /git_safe ls-remote --exit-code --heads "\$GIT_REMOTE_URL" "\$GIT_BRANCH"/);
  assert.match(entrypoint, /git_safe clone --branch "\$GIT_BRANCH" -- "\$GIT_REMOTE_URL" "\$ROOT"/);
  assert.match(entrypoint, /git_safe -C "\$ROOT" checkout -B "\$GIT_BRANCH"/);
  assert.match(entrypoint, /git configure --remote "\$GIT_REMOTE" --branch "\$GIT_BRANCH"/);
  assert.match(entrypoint, /OPENWIKI_GIT_PULL_ON_BOOT/);
  assert.match(entrypoint, /OPENWIKI_SYNC_INTERVAL/);
  assert.match(entrypoint, /OPENWIKI_SYNC_PULL_ON_START/);
  assert.match(entrypoint, /OPENWIKI_SYNC_PUSH_AFTER_COMMIT/);
  assert.match(entrypoint, /sync enable --every "\$SYNC_INTERVAL"/);
  assert.match(entrypoint, /INITIALIZED_ON_BOOT=1/);
  assert.match(entrypoint, /Skipping boot pull because OpenWiki was initialized locally/);

  const compose = await readFile("deploy/compose/docker-compose.yml", "utf8");
  assert.match(compose, /127\.0\.0\.1:3030:3030/);
  assert.doesNotMatch(compose, /^\s*-\s*["']?3030:3030["']?\s*$/m);
  assert.match(compose, /readyz/);
  assert.match(compose, /openwiki_data/);
  assert.match(compose, /openwiki-worker/);
  assert.match(compose, /OPENWIKI_BOOTSTRAP_MODE: skip/);
  assert.match(compose, /x-openwiki-runtime-hardening: &openwiki-runtime-hardening/);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /cap_drop:\n    - ALL/);
  assert.match(compose, /security_opt:\n    - no-new-privileges:true/);
  assert.match(compose, /tmpfs:\n    - \/tmp/);
  assert.match(compose, /OPENWIKI_POSTGRES_IMAGE:-postgres:17@sha256:/);
  assert.match(compose, /DATABASE_URL/);
  assert.match(compose, /\$\{POSTGRES_PASSWORD:\?set POSTGRES_PASSWORD\}/);
  assert.doesNotMatch(compose, /POSTGRES_PASSWORD: openwiki/);
  assert.match(compose, /OPENWIKI_CORS_ORIGIN: "\$\{OPENWIKI_CORS_ORIGIN:-\}"/);
  assert.doesNotMatch(compose, /OPENWIKI_CORS_ORIGIN: "\$\{OPENWIKI_CORS_ORIGIN:-\*\}"/);
  assert.match(compose, /OPENWIKI_QUEUE_BACKEND: postgres/);
  assert.match(compose, /OPENWIKI_WRITE_COORDINATOR_BACKEND: postgres/);
  assert.match(compose, /OPENWIKI_READ_BACKEND: postgres/);
  assert.match(compose, /OPENWIKI_SEARCH_BACKEND: postgres/);
  assert.match(compose, /OPENWIKI_SYNC_INTERVAL/);
  assert.match(compose, /OPENWIKI_SYNC_PUSH_AFTER_COMMIT/);
  assert.match(compose, /openwiki-sync:/);
  assert.match(compose, /profiles: \["sync"\]/);
  assert.match(compose, /sync check-remote --json/);
  assert.match(compose, /sync watch --every/);
  assert.match(compose, /openwiki-backup:/);
  assert.match(compose, /openwiki-postgres-backup:/);
  assert.match(compose, /openwiki-postgres-backup:[\s\S]*<<: \*openwiki-runtime-hardening/);
  assert.match(compose, /pg_dump "\$\$\{DATABASE_URL\}"/);
  assert.match(compose, /profiles: \["backup"\]/);
  assert.match(compose, /backup watch --every/);
  assert.match(compose, /openwiki_backups/);
  assert.match(compose, /minio:/);
  assert.match(compose, /OPENWIKI_MINIO_IMAGE:-quay\.io\/minio\/minio@sha256:/);
  assert.match(compose, /profiles: \["object-storage"\]/);
  assert.match(compose, /minio_data/);
  assert.doesNotMatch(compose, /9000:9000/);
  assert.doesNotMatch(compose, /9001:9001/);
  assert.doesNotMatch(compose, /openwiki-secret/);

  const composeReadme = await readFile("deploy/compose/README.md", "utf8");
  assert.match(composeReadme, /127\.0\.0\.1:3030/);
  assert.match(composeReadme, /local override/);
  assert.match(composeReadme, /OPENWIKI_GIT_REMOTE_URL/);
  assert.match(composeReadme, /OPENWIKI_SYNC_INTERVAL/);
  assert.match(composeReadme, /OPENWIKI_BACKUP_INTERVAL/);
  assert.match(composeReadme, /openwiki_backups/);
  assert.match(composeReadme, /OPENWIKI_WRITE_COORDINATOR_BACKEND=postgres/);
  assert.match(composeReadme, /--profile object-storage/);
  assert.match(composeReadme, /endpoint_url/);
  assert.match(composeReadme, /OPENWIKI_MINIO_ACCESS_KEY/);
  assert.match(composeReadme, /OPENWIKI_MINIO_IMAGE/);
  assert.match(composeReadme, /digest-pinned MinIO/);
  assert.match(composeReadme, /public read-only/);
  assert.match(composeReadme, /trusted SSO or reverse proxy/);

  const codeowners = await readFile(".github/CODEOWNERS", "utf8");
  assert.match(codeowners, /\* @joe-broadhead/);
  for (const ownedPath of [
    ".github/workflows/**",
    "deploy/**",
    "packages/http-api/**",
    "packages/mcp-server/**",
    "packages/git/**",
    "packages/repo/**",
    "schemas/**",
    "SECURITY.md",
    "docs/development/release.md",
    "docs/development/release-notes-template.md",
  ]) {
    assert.match(codeowners, new RegExp(ownedPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  const funding = await readFile(".github/FUNDING.yml", "utf8");
  assert.match(funding, /github: joe-broadhead/);

  const umbrel = await readFile("deploy/umbrel/umbrel-app.yml", "utf8");
  assert.match(umbrel, /id: openwiki/);
  assert.match(umbrel, /private, Git-backed knowledge base/);
  const umbrelCompose = await readFile("deploy/umbrel/docker-compose.yml", "utf8");
  assert.match(umbrelCompose, /backup:/);
  assert.match(umbrelCompose, /\/data\/backups/);
  assert.match(umbrelCompose, /backup[\s\S]*watch/);
  assert.match(umbrelCompose, /read_only: true/);
  assert.match(umbrelCompose, /cap_drop:\n      - ALL/);
  assert.match(umbrelCompose, /security_opt:\n      - no-new-privileges:true/);

  const chart = await readFile("deploy/helm/openwiki/Chart.yaml", "utf8");
  assert.match(chart, /name: openwiki/);
  assert.match(chart, /apiVersion: v2/);

  const values = await readFile("deploy/helm/openwiki/values.yaml", "utf8");
  assert.match(values, /repository: ghcr\.io\/joe-broadhead\/open-wiki/);
  assert.match(values, /enabled: true/);
  assert.match(values, /root: \/data\/wiki/);
  assert.match(values, /runAsNonRoot: true/);
  assert.match(values, /automountServiceAccountToken: false/);
  assert.match(values, /readOnlyRootFilesystem: true/);
  assert.match(values, /drop:\n      - ALL/);
  assert.match(values, /requests:\n    cpu: 100m/);
  assert.match(values, /terminationGracePeriodSeconds: 30/);
  assert.match(values, /deploymentStrategy:\n  type: Recreate/);
  assert.match(values, /podDisruptionBudget:/);
  assert.match(values, /networkPolicy:/);
  assert.match(values, /digest: ""/);
  assert.match(values, /from: \[\]/);
  assert.match(values, /egress: \[\]/);
  assert.doesNotMatch(values, /podSelector: {}/);
  assert.doesNotMatch(values, /namespaceSelector: {}/);
  assert.match(values, /postgresBackup:/);
  assert.match(values, /retentionDays: 30/);
  assert.match(values, /workspaceBackup:/);
  assert.match(values, /destinationId: ""/);
  assert.match(values, /outDir: \/backups/);
  assert.match(values, /startup:\n    enabled: true/);

  const enterpriseValues = await readFile("deploy/helm/openwiki/examples/enterprise-values.yaml", "utf8");
  assert.match(enterpriseValues, /enterprise:\n  enabled: true/);
  assert.match(enterpriseValues, /runtimeMode: enterprise/);
  assert.match(enterpriseValues, /bootstrapMode: skip/);
  assert.match(enterpriseValues, /requireAuth: true/);
  assert.match(enterpriseValues, /trustedAuthHeaders: true/);
  assert.match(enterpriseValues, /trustedAuthHeadersSecret:/);
  assert.match(enterpriseValues, /queueBackend: postgres/);
  assert.match(enterpriseValues, /worker:\n  enabled: true/);
  assert.match(enterpriseValues, /queueReaper:\n  enabled: true/);
  assert.match(enterpriseValues, /networkPolicy:\n  egress:/);

  const helmHelpers = await readFile("deploy/helm/openwiki/templates/_helpers.tpl", "utf8");
  assert.match(helmHelpers, /OPENWIKI_ROOT/);
  assert.match(helmHelpers, /openwiki\.enterpriseValidation/);
  assert.match(helmHelpers, /trustedAuthHeaders=true/);
  assert.match(helmHelpers, /enterprise\.enabled requires openwiki\.bootstrapMode=skip/);
  assert.match(helmHelpers, /OPENWIKI_TRUST_AUTH_HEADERS_SECRET/);
  assert.match(helmHelpers, /OPENWIKI_BOOTSTRAP_MODE/);
  assert.match(helmHelpers, /worker\.replicaCount > 1 requires persistence\.accessModes/);
  assert.match(helmHelpers, /replicaCount > 1 requires openwiki\.operationalStateBackend=postgres/);
  assert.match(helmHelpers, /openwiki\.role process-wide elevation is only allowed with openwiki\.host loopback/);

  const deployment = await readFile("deploy/helm/openwiki/templates/deployment.yaml", "utf8");
  assert.match(deployment, /kind: Deployment/);
  assert.match(deployment, /automountServiceAccountToken/);
  assert.match(deployment, /strategy:\n    \{\{- toYaml \.Values\.deploymentStrategy/);
  assert.match(deployment, /terminationGracePeriodSeconds/);
  assert.match(deployment, /openwiki\.env/);
  assert.match(deployment, /startupProbe:/);
  assert.match(deployment, /\/livez/);
  assert.match(deployment, /\/readyz/);
  assert.match(deployment, /persistentVolumeClaim/);
  assert.match(deployment, /mountPath: \/tmp/);
  assert.match(deployment, /@\{\{ \.Values\.image\.digest \}\}/);

  const service = await readFile("deploy/helm/openwiki/templates/service.yaml", "utf8");
  assert.match(service, /kind: Service/);
  assert.match(service, /targetPort: http/);

  const pdb = await readFile("deploy/helm/openwiki/templates/pdb.yaml", "utf8");
  assert.match(pdb, /kind: PodDisruptionBudget/);
  const networkPolicy = await readFile("deploy/helm/openwiki/templates/networkpolicy.yaml", "utf8");
  assert.match(networkPolicy, /kind: NetworkPolicy/);
  assert.match(networkPolicy, /- Egress/);
  assert.match(networkPolicy, /include "openwiki\.selectorLabels"/);
  assert.match(networkPolicy, /egress:\n\s+\{\{- if \.Values\.networkPolicy\.egress \}\}/);
  const backupCron = await readFile("deploy/helm/openwiki/templates/postgres-backup-cronjob.yaml", "utf8");
  assert.match(backupCron, /kind: CronJob/);
  assert.match(backupCron, /pg_dump/);
  assert.match(backupCron, /postgresBackup\.image\.digest/);
  assert.doesNotMatch(backupCron, /pg_dump "\$DATABASE_URL" \| gzip/);
  assert.match(backupCron, /test -s "\$sql_tmp"/);
  assert.match(backupCron, /mv "\$gzip_tmp" "\$final"/);
  assert.match(backupCron, /find \/backups -type f -name 'openwiki-\*\.sql\.gz' -mtime \+\{\{ \.Values\.postgresBackup\.retentionDays \}\} -delete/);
  const workspaceBackupCron = await readFile("deploy/helm/openwiki/templates/workspace-backup-cronjob.yaml", "utf8");
  assert.match(workspaceBackupCron, /kind: CronJob/);
  assert.match(workspaceBackupCron, /backup create/);
  assert.match(workspaceBackupCron, /backup verify latest/);
  assert.match(workspaceBackupCron, /backup prune/);
  assert.match(workspaceBackupCron, /existingSecret/);
  assert.match(workspaceBackupCron, /\.Values\.securityContext/);
  assert.match(workspaceBackupCron, /resources:/);
  assert.match(workspaceBackupCron, /persistentVolumeClaim/);
  const workspaceBackupPvc = await readFile("deploy/helm/openwiki/templates/workspace-backup-pvc.yaml", "utf8");
  assert.match(workspaceBackupPvc, /PersistentVolumeClaim/);

  const ingress = await readFile("deploy/helm/openwiki/templates/ingress.yaml", "utf8");
  assert.match(ingress, /networking\.k8s\.io\/v1/);

  const helmReadme = await readFile("deploy/helm/openwiki/README.md", "utf8");
  assert.match(helmReadme, /helm upgrade --install openwiki/);
  assert.match(helmReadme, /image\.digest=sha256:<digest>/);
  assert.match(helmReadme, /enterprise-values\.yaml/);
  assert.match(helmReadme, /SSO ingress example/);
  assert.match(helmReadme, /networkPolicy:\n  ingress:\n    from:/);
  assert.match(helmReadme, /kubernetes\.io\/metadata\.name: ingress-nginx/);
  assert.match(helmReadme, /app\.kubernetes\.io\/name: ingress-nginx/);
  assert.match(helmReadme, /openwiki-worker/);
  assert.match(helmReadme, /bootstrapMode: skip/);
  assert.match(helmReadme, /queue reaper CronJob/);
  assert.match(helmReadme, /Postgres write coordinator|OPENWIKI_WRITE_COORDINATOR_BACKEND/);
  assert.match(helmReadme, /workspaceBackup\.enabled=true/);
  assert.match(helmReadme, /Restore order/);

  const kustomization = await readFile("deploy/kubernetes/base/kustomization.yaml", "utf8");
  assert.match(kustomization, /kind: Kustomization/);
  assert.match(kustomization, /labels:/);
  assert.doesNotMatch(kustomization, /commonLabels/);
  assert.match(kustomization, /deployment\.yaml/);
  assert.match(kustomization, /service\.yaml/);
  assert.match(kustomization, /pvc\.yaml/);
  assert.match(kustomization, /workspace-backup-pvc\.yaml/);
  assert.match(kustomization, /pdb\.yaml/);
  assert.match(kustomization, /networkpolicy\.yaml/);
  assert.match(kustomization, /workspace-backup-cronjob\.yaml/);
  assert.match(kustomization, /postgres-backup-cronjob\.yaml/);

  const kubernetesDeployment = await readFile("deploy/kubernetes/base/deployment.yaml", "utf8");
  assert.match(kubernetesDeployment, /kind: Deployment/);
  assert.match(kubernetesDeployment, /ghcr\.io\/joe-broadhead\/open-wiki:0\.0\.0/);
  assert.match(kubernetesDeployment, /automountServiceAccountToken: false/);
  assert.match(kubernetesDeployment, /OPENWIKI_ROOT/);
  assert.match(kubernetesDeployment, /\/livez/);
  assert.match(kubernetesDeployment, /\/readyz/);
  assert.match(kubernetesDeployment, /claimName: openwiki-data/);
  assert.match(kubernetesDeployment, /runAsNonRoot: true/);
  assert.match(kubernetesDeployment, /readOnlyRootFilesystem: true/);
  assert.match(kubernetesDeployment, /type: Recreate/);
  assert.match(kubernetesDeployment, /startupProbe:/);
  assert.match(kubernetesDeployment, /terminationGracePeriodSeconds: 30/);
  assert.match(kubernetesDeployment, /drop:\n                - ALL/);
  assert.match(kubernetesDeployment, /requests:\n              cpu: 100m/);

  const kubernetesPdb = await readFile("deploy/kubernetes/base/pdb.yaml", "utf8");
  assert.match(kubernetesPdb, /kind: PodDisruptionBudget/);
  const kubernetesNetworkPolicy = await readFile("deploy/kubernetes/base/networkpolicy.yaml", "utf8");
  assert.match(kubernetesNetworkPolicy, /kind: NetworkPolicy/);
  assert.match(kubernetesNetworkPolicy, /- Egress/);
  assert.match(kubernetesNetworkPolicy, /app\.kubernetes\.io\/name: openwiki/);
  assert.match(kubernetesNetworkPolicy, /egress: \[\]/);
  assert.doesNotMatch(kubernetesNetworkPolicy, /podSelector: {}/);
  assert.doesNotMatch(kubernetesNetworkPolicy, /namespaceSelector: {}/);
  const kubernetesBackupCron = await readFile("deploy/kubernetes/base/postgres-backup-cronjob.yaml", "utf8");
  assert.match(kubernetesBackupCron, /kind: CronJob/);
  assert.match(kubernetesBackupCron, /pg_dump/);
  assert.doesNotMatch(kubernetesBackupCron, /pg_dump "\$DATABASE_URL" \| gzip/);
  assert.match(kubernetesBackupCron, /test -s "\$sql_tmp"/);
  assert.match(kubernetesBackupCron, /mv "\$gzip_tmp" "\$final"/);
  assert.match(kubernetesBackupCron, /find \/backups -type f -name 'openwiki-\*\.sql\.gz' -mtime \+30 -delete/);
  const kubernetesWorkspaceBackupCron = await readFile("deploy/kubernetes/base/workspace-backup-cronjob.yaml", "utf8");
  assert.match(kubernetesWorkspaceBackupCron, /kind: CronJob/);
  assert.match(kubernetesWorkspaceBackupCron, /suspend: true/);
  assert.match(kubernetesWorkspaceBackupCron, /backup create/);
  assert.match(kubernetesWorkspaceBackupCron, /backup verify latest/);
  assert.match(kubernetesWorkspaceBackupCron, /runAsNonRoot: true/);
  assert.match(kubernetesWorkspaceBackupCron, /readOnlyRootFilesystem: true/);
  assert.match(kubernetesWorkspaceBackupCron, /drop:\n\s+- ALL/);
  assert.match(kubernetesWorkspaceBackupCron, /claimName: openwiki-workspace-backups/);
  const kubernetesWorkspaceBackupPvc = await readFile("deploy/kubernetes/base/workspace-backup-pvc.yaml", "utf8");
  assert.match(kubernetesWorkspaceBackupPvc, /openwiki-workspace-backups/);

  const kubernetesService = await readFile("deploy/kubernetes/base/service.yaml", "utf8");
  assert.match(kubernetesService, /kind: Service/);
  assert.match(kubernetesService, /targetPort: http/);

  const kubernetesReadme = await readFile("deploy/kubernetes/base/README.md", "utf8");
  assert.match(kubernetesReadme, /kubectl apply -k deploy\/kubernetes\/base/);
  assert.match(kubernetesReadme, /PodDisruptionBudget/);
  assert.match(kubernetesReadme, /NetworkPolicy/);
  assert.match(kubernetesReadme, /openwiki-workspace-backup/);
  assert.match(kubernetesReadme, /openwiki-postgres-backup/);
  assert.match(kubernetesReadme, /Restore a hosted deployment in this order/);
  assert.match(kubernetesReadme, /openwiki-worker/);
  assert.match(kubernetesReadme, /namespaceSelector: {}/);

  const dockerDocs = await readFile("docs/deployment/docker.md", "utf8");
  assert.match(dockerDocs, /127\.0\.0\.1:3030:3030/);
  assert.match(dockerDocs, /Bind to a private address or all\s+interfaces only/);
  assert.match(dockerDocs, /scans it with Trivy/);
  assert.match(dockerDocs, /signs the pushed digest with keyless Cosign/);
  assert.match(dockerDocs, /ghcr\.io\/joe-broadhead\/open-wiki@sha256:<digest>/);

  const operationsDocs = await readFile("docs/deployment/operations.md", "utf8");
  assert.match(operationsDocs, /Focused Runbooks/);
  assert.match(operationsDocs, /operations\/matrix\.md/);
  assert.match(operationsDocs, /operations\/write-coordination\.md/);
  assert.match(operationsDocs, /operations\/backup-restore\.md/);
  assert.match(operationsDocs, /operations\/postgres-and-workers\.md/);
  const operationsMatrix = await readFile("docs/deployment/operations/matrix.md", "utf8");
  for (const required of [
    "`local-personal`",
    "`local-team`",
    "`docker-private`",
    "`hosted-enterprise`",
    "`kubernetes-enterprise`",
    "`aws-ecs-efs`",
    "`gcp-gke`",
    "`cloud-run-readmostly`",
    "`umbrel`",
    "`public-static`",
    "OpenWiki service-account token",
    "Trusted proxy secret",
    "Postgres password",
    "artifacts/deployment/",
  ]) {
    assert.match(operationsMatrix, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  const writeCoordinationDocs = await readFile("docs/deployment/operations/write-coordination.md", "utf8");
  assert.match(writeCoordinationDocs, /db write-lease --json/);
  assert.match(writeCoordinationDocs, /db recover-write-lease --json/);
  const postgresWorkerDocs = await readFile("docs/deployment/operations/postgres-and-workers.md", "utf8");
  assert.match(postgresWorkerDocs, /runs reap-stale --max-runtime-ms/);
  assert.match(postgresWorkerDocs, /runs cancel run:\.\.\./);
  assert.match(postgresWorkerDocs, /db check --json/);
  assert.match(postgresWorkerDocs, /db migrate[\s\S]*index --json[\s\S]*db rebuild --json[\s\S]*db sync-postgres --full/);
  const backupRestoreDocs = await readFile("docs/deployment/operations/backup-restore.md", "utf8");
  assert.match(backupRestoreDocs, /pnpm backup:postgres:restore-drill/);
  assert.match(backupRestoreDocs, /restore-database-url/);
  assert.match(backupRestoreDocs, /db migrate[\s\S]*index(?: --json)?[\s\S]*db rebuild(?: --json)?[\s\S]*db sync-postgres --full/);

  const performanceDocs = await readFile("docs/deployment/performance.md", "utf8");
  assert.match(performanceDocs, /10k-record hosted workspace/);
  assert.match(performanceDocs, /within five minutes/);
  assert.match(performanceDocs, /within ten seconds/);

  const profileDocs = await readFile("docs/deployment/profiles.md", "utf8");
  for (const profile of [
    "local-personal",
    "public-static",
    "docker-private",
    "hosted-enterprise",
    "kubernetes-enterprise",
    "aws-ecs-efs",
    "gcp-gke",
    "cloud-run-readmostly",
  ]) {
    assert.match(profileDocs, new RegExp("`" + profile + "`"));
  }
  for (const profile of [
    "local-personal",
    "public-static",
    "docker-private",
    "hosted-enterprise",
    "kubernetes-enterprise",
    "aws-ecs-efs",
    "gcp-gke",
    "cloud-run-readmostly",
  ]) {
    assert.match(profileDocs, new RegExp("--deploy-profile " + profile));
  }
  assert.match(profileDocs, /Rollback/);
  assert.match(profileDocs, /Backup Model/);
  assert.match(profileDocs, /Cloud Storage FUSE is not POSIX Git storage/);
  assert.match(profileDocs, /proper POSIX\s+filesystem/);
  assert.match(profileDocs, /No server writes|no server writes/);
  assert.match(profileDocs, /profiles\/local-personal\.md/);
  assert.match(profileDocs, /profiles\/docker-compose\.md/);
  assert.match(profileDocs, /profiles\/kubernetes-helm\.md/);
  assert.match(profileDocs, /profiles\/cloud-run\.md/);
  assert.match(profileDocs, /profiles\/umbrel\.md/);
  assert.doesNotMatch(profileDocs, /public unauthenticated write/i);

  const smokeDocs = await readFile("docs/deployment/smoke.md", "utf8");
  assert.match(smokeDocs, /Deployment Smoke Checks/);
  assert.match(smokeDocs, /disposable/);
  assert.match(smokeDocs, /pnpm smoke:kubernetes/);
  assert.match(smokeDocs, /terraform destroy/);

  const proxyDocs = await readFile("deploy/proxy/README.md", "utf8");
  assert.match(proxyDocs, /trusted identity headers/);
  assert.match(proxyDocs, /openwiki-proxy-secret\.conf/);
  const nginxProxy = await readFile("deploy/proxy/nginx-oauth2-proxy.conf", "utf8");
  assert.match(nginxProxy, /auth_request \/oauth2\/auth/);
  assert.match(nginxProxy, /default "actor:user:\$auth_user"/);
  assert.match(nginxProxy, /X-OpenWiki-Proxy-Secret/);
  assert.match(nginxProxy, /include \/etc\/nginx\/openwiki\/openwiki-proxy-secret\.conf/);
  assert.match(nginxProxy, /X-OpenWiki-Proxy-Secret \$openwiki_proxy_secret/);
  assert.doesNotMatch(nginxProxy, /replace-with-a-random-shared-secret/);
  assert.match(nginxProxy, /X-OpenWiki-Role ""/);
  assert.match(nginxProxy, /X-OpenWiki-Scopes ""/);
  assert.match(nginxProxy, /X-OpenWiki-Principals ""/);
  assert.match(nginxProxy, /X-OpenWiki-Groups ""/);
  assert.match(nginxProxy, /limit_req_zone/);

  const rateLimitDocs = await readFile("docs/deployment/rate-limiting.md", "utf8");
  assert.match(rateLimitDocs, /external limiter/);
  assert.match(rateLimitDocs, /multi-replica/);
});

test("production-facing deployment examples avoid mutable image tags", async () => {
  const deploymentFiles = (await listTextFiles("deploy")).filter((file) => /\.(?:ya?ml|tf)$/.test(file));
  const allowedMutableImages = new Map([
    ["deploy/compose/docker-compose.yml::openwiki/openwiki:local", "Local Compose build target, not a published runtime image."],
  ]);
  const violations: string[] = [];

  for (const file of deploymentFiles) {
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(/^\s*image:\s*["']?([^"'\s#]+)["']?/gm)) {
      const image = match[1] ?? "";
      const key = `${file}::${image}`;
      if (allowedMutableImages.has(key)) {
        continue;
      }
      if (hasMutableImageTag(image)) {
        violations.push(`${file}: ${image}`);
      }
    }
    for (const match of source.matchAll(/^\s*tag:\s*["']?([^"'\s#]+)["']?/gm)) {
      const tag = match[1] ?? "";
      if (isMutableImageTag(tag)) {
        violations.push(`${file}: tag ${tag}`);
      }
    }
  }

  assert.deepEqual(violations.sort(), []);
});

test("release local profile smoke exits non-zero when readiness stores are missing", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, ["--no-warnings", "--import", "tsx", "scripts/openwiki-release-smoke.mjs", "local-personal-missing-readiness"], {
      cwd: process.cwd(),
    }),
    (error: unknown) => {
      const candidate = error as { code?: number; stdout?: string; stderr?: string };
      assert.equal(candidate.code, 1);
      assert.match(`${candidate.stdout ?? ""}\n${candidate.stderr ?? ""}`, /Readiness stores missing/);
      return true;
    },
  );
});

test("Postgres restore drill helper emits redacted dry-run plans and refuses unsafe targets", async () => {
  const result = await execFileAsync(
    process.execPath,
    [
      "--no-warnings",
      "scripts/openwiki-postgres-restore-drill.mjs",
      "--database-url",
      "postgres://openwiki:supersecret@db.example/openwiki",
      "--restore-database-url",
      "postgres://openwiki:restoresecret@db.example/openwiki_restore",
      "--workspace-root",
      "/data/wiki",
      "--dry-run",
      "--json",
    ],
    { cwd: process.cwd() },
  );
  const plan = JSON.parse(result.stdout) as {
    schema_version?: string;
    status?: string;
    mode?: string;
    commands?: Array<{ name?: string; command?: string }>;
  };
  assert.equal(plan.schema_version, "openwiki-postgres-restore-drill-v1");
  assert.equal(plan.status, "planned");
  assert.equal(plan.mode, "dry_run");
  assert.deepEqual(plan.commands?.map((command) => command.name), ["dump", "restore", "migrate", "sync_postgres", "check"]);
  assert.doesNotMatch(JSON.stringify(plan), /supersecret|restoresecret/);
  assert.match(plan.commands?.find((command) => command.name === "dump")?.command ?? "", /pg_dump/);
  assert.match(plan.commands?.find((command) => command.name === "restore")?.command ?? "", /pg_restore/);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "--no-warnings",
        "scripts/openwiki-postgres-restore-drill.mjs",
        "--database-url",
        "postgres://openwiki:supersecret@db.example/openwiki",
        "--restore-database-url",
        "postgres://restore_user:othersecret@db.example/openwiki",
        "--dry-run",
        "--json",
      ],
      { cwd: process.cwd() },
    ),
    (error: unknown) => {
      const candidate = error as { code?: number; stdout?: string };
      assert.equal(candidate.code, 1);
      assert.match(candidate.stdout ?? "", /same Postgres URL/);
      assert.doesNotMatch(candidate.stdout ?? "", /supersecret/);
      return true;
    },
  );
});

async function listTextFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const resolved = path.join(root, entry.name);
      if (entry.isDirectory()) {
        return listTextFiles(resolved);
      }
      return entry.isFile() ? [resolved] : [];
    }),
  );
  return files.flat();
}

function hasMutableImageTag(image: string): boolean {
  if (image.includes("@sha256:")) {
    return false;
  }
  if (image.includes("{{")) {
    return false;
  }
  const colon = image.lastIndexOf(":");
  if (colon === -1 || colon < image.lastIndexOf("/")) {
    return true;
  }
  return isMutableImageTag(image.slice(colon + 1));
}

function isMutableImageTag(tag: string): boolean {
  return /^(?:latest|stable|main|master|edge|nightly|dev)$/i.test(tag);
}

test("public distribution metadata matches supported release channels", async () => {
  const rootPackage = JSON.parse(await readFile("package.json", "utf8")) as {
    private?: boolean;
    description?: string;
    license?: string;
    repository?: { type?: string; url?: string };
    bugs?: { url?: string };
    keywords?: string[];
    scripts?: Record<string, string>;
  };
  assert.equal(rootPackage.private, true);
  assert.match(rootPackage.description ?? "", /Git-backed/);
  assert.equal(rootPackage.license, "MIT");
  assert.equal(rootPackage.repository?.type, "git");
  // Accept standalone open-wiki clone or monorepo import under open-cowork.
  assert.match(
    rootPackage.repository?.url ?? "",
    /github\.com\/joe-broadhead\/(open-wiki|open-cowork)/,
  );
  assert.match(rootPackage.bugs?.url ?? "", /\/issues$/);
  assert.ok(rootPackage.keywords?.includes("mcp"));
  assert.equal(rootPackage.scripts?.["release:evidence"], "node --no-warnings --import tsx scripts/openwiki-release-evidence.mjs");
  assert.equal(rootPackage.scripts?.["smoke:kubernetes"], "node --no-warnings scripts/openwiki-kind-smoke.mjs");
  assert.equal(rootPackage.scripts?.["backup:postgres:restore-drill"], "node --no-warnings scripts/openwiki-postgres-restore-drill.mjs");

  const packageDirs = await readdir("packages", { withFileTypes: true });
  for (const entry of packageDirs) {
    if (!entry.isDirectory()) {
      continue;
    }
    const packageJson = JSON.parse(await readFile(path.join("packages", entry.name, "package.json"), "utf8")) as { private?: boolean };
    assert.equal(packageJson.private, true, `${entry.name} workspace package must stay private; release only the generated CLI package artifact`);
  }

  const cliDistPackage = JSON.parse(await readFile(path.join("packages", "cli", "dist", "package.json"), "utf8").catch(() => "{}")) as { name?: string; bin?: Record<string, string>; files?: string[] };
  if (cliDistPackage.name !== undefined) {
    assert.equal(cliDistPackage.name, "@openwiki/cli");
    assert.equal(cliDistPackage.bin?.openwiki, "./openwiki.js");
    assert.ok(cliDistPackage.files?.includes("assets"));
  }
  const cliBuildScript = await readFile(path.join("packages", "cli", "scripts", "build.mjs"), "utf8");
  for (const required of ["schemas", "templates", "reference", "LICENSE", "build-metadata.json"]) {
    assert.match(cliBuildScript, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  const distributionDocs = await readFile(path.join("docs", "reference", "distribution.md"), "utf8");
  assert.match(distributionDocs, /Source checkout \| Supported/);
  assert.match(distributionDocs, /Docker image \| Release-candidate image path/);
  assert.match(distributionDocs, /npm CLI package \| Release-candidate artifact/);
  assert.match(distributionDocs, /pnpm pack:cli/);
  assert.match(distributionDocs, /npm install -g \.\/artifacts\/npm\/openwiki-cli-0\.0\.0\.tgz/);
  assert.match(distributionDocs, /npm install -g @openwiki\/cli@0\.0\.0/);
  assert.match(distributionDocs, /openwiki self-check/);
  assert.match(distributionDocs, /npm install --save-dev @openwiki\/cli@0\.0\.0/);
  assert.match(distributionDocs, /npm exec --package @openwiki\/cli@0\.0\.0/);
  assert.match(distributionDocs, /Homebrew or native package manager \| Deferred/);
  assert.match(distributionDocs, /npm uninstall -g @openwiki\/cli/);
});

test("release evidence and kind smoke helpers emit local artifacts without publishing", async () => {
  const evidence = await execFileAsync(process.execPath, ["--no-warnings", "--import", "tsx", "scripts/openwiki-release-evidence.mjs"], {
    cwd: process.cwd(),
  });
  assert.match(evidence.stdout, /openwiki-release-evidence\.json/);
  const evidenceJson = JSON.parse(await readFile(path.join("artifacts", "openwiki-release-evidence.json"), "utf8")) as {
    schema_version?: string;
    release_workflow_executed?: boolean;
    excluded_release_steps?: string[];
    distribution_commands?: Record<string, string>;
    distribution_artifacts?: { npm_tarballs?: string[] };
    deployment_evidence?: {
      artifact?: string;
      entries?: Array<{ profile?: string; status?: string; artifact?: string; inputs?: string[] }>;
    };
  };
  assert.equal(evidenceJson.schema_version, "openwiki-release-evidence-v1");
  assert.equal(evidenceJson.release_workflow_executed, false);
  assert.ok(evidenceJson.excluded_release_steps?.includes("Run the release workflow"));
  assert.match(evidenceJson.distribution_commands?.published_install ?? "", /npm install -g @openwiki\/cli@0\.0\.0/);
  assert.ok(Array.isArray(evidenceJson.distribution_artifacts?.npm_tarballs));
  assert.equal(evidenceJson.deployment_evidence?.artifact, "artifacts/deployment/openwiki-deployment-evidence.json");
  assert.ok(evidenceJson.deployment_evidence?.entries?.some((entry) => entry.profile === "docker-private"));
  assert.ok(evidenceJson.deployment_evidence?.entries?.some((entry) => entry.profile === "kubernetes-enterprise"));
  assert.ok(evidenceJson.deployment_evidence?.entries?.some((entry) => entry.profile === "aws-ecs-efs"));
  assert.ok(evidenceJson.deployment_evidence?.entries?.every((entry) => ["passed", "failed", "tool_unavailable"].includes(entry.status ?? "")));
  const deploymentEvidence = JSON.parse(await readFile(path.join("artifacts", "deployment", "openwiki-deployment-evidence.json"), "utf8")) as {
    schema_version?: string;
    entries?: Array<{ inputs?: string[] }>;
  };
  assert.equal(deploymentEvidence.schema_version, "openwiki-deployment-evidence-v1");
  assert.ok(deploymentEvidence.entries?.some((entry) => entry.inputs?.includes("deploy/compose/docker-compose.yml")));
  assert.ok(deploymentEvidence.entries?.some((entry) => entry.inputs?.includes("deploy/helm/openwiki/examples/enterprise-values.yaml")));

  const kindSmoke = await execFileAsync(process.execPath, ["--no-warnings", "scripts/openwiki-kind-smoke.mjs"], {
    cwd: process.cwd(),
  });
  assert.match(kindSmoke.stdout, /Planned kind smoke/);
  const kindJson = JSON.parse(await readFile(path.join("artifacts", "openwiki-kind-smoke.json"), "utf8")) as {
    schema_version?: string;
    enabled?: boolean;
    status?: string;
    commands?: string[];
  };
  assert.equal(kindJson.schema_version, "openwiki-kind-smoke-v1");
  assert.equal(kindJson.enabled, false);
  assert.equal(kindJson.status, "planned");
  assert.ok(kindJson.commands?.some((command) => command.includes("kubectl apply -k deploy/kubernetes/base")));
});
