# Open Cowork Cloud — AWS reference module (ECS Fargate + RDS + S3 + ALB).
#
# Reference IaC for the recipe in deploy/aws/README.md: split cloud roles as
# Fargate services (web behind an ALB; worker/scheduler internal), Postgres on
# RDS, artifacts on S3, secrets in Secrets Manager. Networking (VPC, subnets)
# is accepted as input — bring your own landing zone. Keep account ids, image
# tags, domains, and secret VALUES in a private deployment repo; this module
# only references secret ARNs.
#
# Validate with `terraform init && terraform validate` and review the plan
# before applying to a real account; this module is a starting point, not a
# managed product.

terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.60"
    }
  }
}

provider "aws" {
  region = var.region
}

locals {
  roles = {
    web = {
      role          = "web"
      desired_count = var.web_desired_count
      public        = true
      health_port   = 8787
      health_path   = "/readyz"
    }
    worker = {
      role          = "worker"
      desired_count = var.worker_desired_count
      public        = false
      health_port   = 8788
      health_path   = "/livez"
    }
    scheduler = {
      role          = "scheduler"
      desired_count = 1
      public        = false
      health_port   = 8788
      health_path   = "/livez"
    }
  }

  common_env = [
    { name = "OPEN_COWORK_CLOUD_HOST", value = "0.0.0.0" },
    { name = "OPEN_COWORK_CLOUD_PORT", value = "8787" },
    { name = "OPEN_COWORK_CLOUD_RUN_MIGRATIONS", value = "false" },
    { name = "OPEN_COWORK_CLOUD_OBJECT_STORE_KIND", value = "s3" },
    { name = "OPEN_COWORK_CLOUD_OBJECT_STORE_BUCKET", value = aws_s3_bucket.artifacts.bucket },
    { name = "OPEN_COWORK_CLOUD_OBJECT_STORE_REGION", value = var.region },
  ]

  runtime_secret_arns  = distinct(concat(var.secret_arns, values(var.secret_env)))
  migrator_secret_arns = distinct(values(var.migrator_secret_env))
}

# ---------------------------------------------------------------------------
# Artifact store
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "artifacts" {
  bucket = "${var.name_prefix}-artifacts-${data.aws_caller_identity.current.account_id}"
}

data "aws_caller_identity" "current" {}

resource "aws_s3_bucket_versioning" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket                  = aws_s3_bucket.artifacts.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# ---------------------------------------------------------------------------
# Control plane database
# ---------------------------------------------------------------------------

resource "aws_db_subnet_group" "cloud" {
  name       = "${var.name_prefix}-postgres"
  subnet_ids = var.private_subnet_ids
}

resource "aws_security_group" "postgres" {
  name_prefix = "${var.name_prefix}-postgres-"
  vpc_id      = var.vpc_id

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.service.id]
  }
}

resource "aws_db_instance" "cloud" {
  identifier                  = "${var.name_prefix}-postgres"
  engine                      = "postgres"
  engine_version              = var.postgres_engine_version
  instance_class              = var.database_instance_class
  allocated_storage           = var.database_allocated_storage_gb
  db_name                     = "open_cowork_cloud"
  username                    = var.database_user
  manage_master_user_password = true # password lives in Secrets Manager, not state
  db_subnet_group_name        = aws_db_subnet_group.cloud.name
  vpc_security_group_ids      = [aws_security_group.postgres.id]
  backup_retention_period     = 7
  deletion_protection         = true
  skip_final_snapshot         = false
  final_snapshot_identifier   = "${var.name_prefix}-postgres-final"
  storage_encrypted           = true
}

# ---------------------------------------------------------------------------
# ECS cluster, task roles, and role services
# ---------------------------------------------------------------------------

resource "aws_ecs_cluster" "cloud" {
  name = "${var.name_prefix}-cloud"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_security_group" "service" {
  name_prefix = "${var.name_prefix}-service-"
  vpc_id      = var.vpc_id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group_rule" "web_from_alb" {
  type                     = "ingress"
  from_port                = 8787
  to_port                  = 8787
  protocol                 = "tcp"
  security_group_id        = aws_security_group.service.id
  source_security_group_id = aws_security_group.alb.id
}

data "aws_iam_policy_document" "task_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "task_execution" {
  name_prefix        = "${var.name_prefix}-exec-"
  assume_role_policy = data.aws_iam_policy_document.task_assume.json
}

resource "aws_iam_role_policy_attachment" "task_execution" {
  role       = aws_iam_role.task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution_secrets" {
  count = length(local.runtime_secret_arns) > 0 ? 1 : 0
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = local.runtime_secret_arns
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  count  = length(local.runtime_secret_arns) > 0 ? 1 : 0
  name   = "secrets-read"
  role   = aws_iam_role.task_execution.id
  policy = data.aws_iam_policy_document.execution_secrets[0].json
}

# Migration authority is isolated from every long-running task. The task is
# materialized only after the operator supplies a dedicated migrator URL
# secret; the runtime execution role can never read that secret.
resource "aws_iam_role" "migrator_execution" {
  name_prefix        = "${var.name_prefix}-migrator-exec-"
  assume_role_policy = data.aws_iam_policy_document.task_assume.json
}

resource "aws_iam_role_policy_attachment" "migrator_execution" {
  role       = aws_iam_role.migrator_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "migrator_execution_secrets" {
  count = length(local.migrator_secret_arns) > 0 ? 1 : 0
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = local.migrator_secret_arns
  }
}

resource "aws_iam_role_policy" "migrator_execution_secrets" {
  count  = length(local.migrator_secret_arns) > 0 ? 1 : 0
  name   = "migrator-secrets-read"
  role   = aws_iam_role.migrator_execution.id
  policy = data.aws_iam_policy_document.migrator_execution_secrets[0].json
}

resource "aws_iam_role" "migrator_task" {
  name_prefix        = "${var.name_prefix}-migrator-task-"
  assume_role_policy = data.aws_iam_policy_document.task_assume.json
}

resource "aws_iam_role" "task" {
  name_prefix        = "${var.name_prefix}-task-"
  assume_role_policy = data.aws_iam_policy_document.task_assume.json
}

data "aws_iam_policy_document" "artifacts_rw" {
  statement {
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:ListBucket",
    ]
    resources = [
      aws_s3_bucket.artifacts.arn,
      "${aws_s3_bucket.artifacts.arn}/*",
    ]
  }
}

resource "aws_iam_role_policy" "artifacts_rw" {
  name   = "artifacts-rw"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.artifacts_rw.json
}

resource "aws_cloudwatch_log_group" "cloud" {
  name              = "/ecs/${var.name_prefix}-cloud"
  retention_in_days = var.log_retention_days
}

resource "aws_ecs_task_definition" "cloud" {
  for_each = local.roles

  family                   = "${var.name_prefix}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.task_cpu
  memory                   = var.task_memory_mb
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([
    {
      name      = "open-cowork-cloud"
      image     = var.cloud_image
      essential = true
      portMappings = [
        {
          name          = each.key == "web" ? "http" : "livez"
          containerPort = each.value.health_port
          protocol      = "tcp"
        }
      ]
      environment = concat(
        [{ name = "OPEN_COWORK_CLOUD_ROLE", value = each.value.role }],
        local.common_env,
        each.key == "web" ? [] : [
          { name = "OPEN_COWORK_CLOUD_LIVENESS_PORT", value = tostring(each.value.health_port) }
        ],
      )
      # OPEN_COWORK_CLOUD_CONTROL_PLANE_URL must arrive via secret_env as a
      # least-privilege runtime URL. Never expose the RDS master/migrator
      # secret to these long-running roles.
      secrets = [
        for env_name, arn in var.secret_env : { name = env_name, valueFrom = arn }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.cloud.name
          awslogs-region        = var.region
          awslogs-stream-prefix = each.key
        }
      }
      # ECS does not honor the Dockerfile HEALTHCHECK after an explicit task
      # healthCheck is configured. Keep the role contract in the task
      # definition: web proves dependency readiness while execution-only roles
      # prove their event-loop heartbeat on a separate, non-conflicting port.
      healthCheck = {
        command = [
          "CMD",
          "node",
          "-e",
          "fetch('http://127.0.0.1:${each.value.health_port}${each.value.health_path}').then((response)=>process.exit(response.ok?0:1)).catch(()=>process.exit(1))",
        ]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 30
      }
    }
  ])
}

# Executable first-deploy/upgrade path. Apply with deploy_runtime_services=false,
# run this exact digest-pinned task to success, then explicitly enable services.
resource "aws_ecs_task_definition" "migrator" {
  count = length(local.migrator_secret_arns) > 0 ? 1 : 0

  family                   = "${var.name_prefix}-migrator"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.task_cpu
  memory                   = var.task_memory_mb
  execution_role_arn       = aws_iam_role.migrator_execution.arn
  task_role_arn            = aws_iam_role.migrator_task.arn

  container_definitions = jsonencode([
    {
      name      = "open-cowork-cloud-migrator"
      image     = var.cloud_image
      essential = true
      command = [
        "node",
        "--experimental-sqlite",
        "apps/desktop/dist/cloud/open-cowork-cloud-migrate.mjs",
      ]
      environment = [
        for env_name, value in var.migrator_env : { name = env_name, value = value }
      ]
      secrets = [
        for env_name, arn in var.migrator_secret_env : { name = env_name, valueFrom = arn }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.cloud.name
          awslogs-region        = var.region
          awslogs-stream-prefix = "migrator"
        }
      }
    }
  ])

  lifecycle {
    precondition {
      condition     = contains(keys(var.migrator_secret_env), "OPEN_COWORK_CLOUD_CONTROL_PLANE_URL")
      error_message = "migrator_secret_env must inject OPEN_COWORK_CLOUD_CONTROL_PLANE_URL from a dedicated migrator secret."
    }
    precondition {
      condition     = contains(keys(var.migrator_env), "OPEN_COWORK_CLOUD_RUNTIME_DATABASE_ROLE") && contains(keys(var.migrator_env), "OPEN_COWORK_CLOUD_RUNTIME_DATABASE_PRINCIPAL")
      error_message = "migrator_env must set the dedicated runtime database role and principal together."
    }
  }
}

resource "aws_ecs_service" "cloud" {
  # This hard gate keeps a first apply from booting services against an empty
  # database. Enabling it is a separate reviewed apply after the migrator task
  # has exited successfully.
  for_each = var.deploy_runtime_services ? local.roles : {}

  name            = "${var.name_prefix}-${each.key}"
  cluster         = aws_ecs_cluster.cloud.id
  task_definition = aws_ecs_task_definition.cloud[each.key].arn
  desired_count   = each.value.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.service.id]
    assign_public_ip = false
  }

  dynamic "load_balancer" {
    for_each = each.value.public ? [1] : []
    content {
      target_group_arn = aws_lb_target_group.web[0].arn
      container_name   = "open-cowork-cloud"
      container_port   = 8787
    }
  }
}

# ---------------------------------------------------------------------------
# Public entry (web role only)
# ---------------------------------------------------------------------------

resource "aws_security_group" "alb" {
  name_prefix = "${var.name_prefix}-alb-"
  vpc_id      = var.vpc_id

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_lb" "web" {
  count              = 1
  name               = "${var.name_prefix}-web"
  load_balancer_type = "application"
  subnets            = var.public_subnet_ids
  security_groups    = [aws_security_group.alb.id]
  # SSE requires long idle: default 60s drops quiet event streams.
  idle_timeout = 3600
}

resource "aws_lb_target_group" "web" {
  count       = 1
  name        = "${var.name_prefix}-web"
  port        = 8787
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = var.vpc_id

  health_check {
    path                = "/readyz"
    matcher             = "200"
    interval            = 30
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "web_https" {
  count             = 1
  load_balancer_arn = aws_lb.web[0].arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.acm_certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web[0].arn
  }
}
