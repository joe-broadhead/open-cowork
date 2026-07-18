# Deployment Overview

Choose the deployment mode by trust boundary and workload. The canonical
decision table and per-profile runbooks live in
[Deployment Profiles](profiles.md).

| Profile | Best For | Write Access |
| --- | --- | --- |
| `local-personal` | Personal wiki with local stdio MCP agents | Local trusted user |
| `public-static` | Public read-only sites | No server writes |
| `docker-private` | Trusted team or private server | Behind auth boundary |
| `hosted-enterprise` | Provider-neutral hosted humans and agents | Behind SSO/proxy/private gateway |
| `kubernetes-enterprise` | Larger hosted deployments | Behind auth boundary |
| `aws-ecs-efs` | AWS ECS/Fargate with EFS | Behind ALB/auth boundary |
| `gcp-gke` | Google Cloud enterprise deployment | Behind Ingress/IAP |
| `cloud-run-readmostly` | Preview/demo/read-mostly Cloud Run | Not recommended for production writes |

Git remains canonical in every tier. Runtime databases, search indexes, object
storage, and static artifacts are derived serving layers.

For hosted write-capable deployments, review the [operations runbook](operations.md),
the [hosted humans and agents cookbook](hosted-human-agent.md),
the focused [write coordination](operations/write-coordination.md) and
[backup/restore](operations/backup-restore.md) pages, and the
[SSO/reverse-proxy auth guide](auth-boundaries.md) before exposing the service
to a network. The deployment assets are strong starting points, but production
readiness depends on auth boundary, backups, observability, and restore drills.

Every profile has a matching preflight command:

```sh
openwiki --root <wiki> deploy preflight --deploy-profile <profile>
```

Use the [deployment smoke checklist](smoke.md) in disposable infrastructure
before copying a profile into a long-lived environment.
