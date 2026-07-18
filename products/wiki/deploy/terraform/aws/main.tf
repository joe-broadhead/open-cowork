provider "aws" {
  region = var.region
}

locals {
  port                = 3030
  runtime_secret_arns = sort(tolist(toset([var.database_url_secret_arn, var.trusted_auth_headers_secret_arn])))
}

resource "terraform_data" "production_guardrails" {
  input = {
    production_mode     = var.production_mode
    auth_boundary_notes = var.auth_boundary_notes
  }

  lifecycle {
    precondition {
      condition     = !var.production_mode || var.certificate_arn != ""
      error_message = "AWS production_mode requires certificate_arn so the ALB serves HTTPS and redirects HTTP."
    }
    precondition {
      condition     = !var.production_mode || can(regex("@sha256:", var.image))
      error_message = "AWS production_mode requires a digest-pinned OpenWiki image."
    }
  }
}

resource "aws_cloudwatch_log_group" "openwiki" {
  name              = "/ecs/${var.name}"
  retention_in_days = 14
}

resource "aws_ecs_cluster" "openwiki" {
  name = var.name
}

resource "aws_security_group" "alb" {
  name        = "${var.name}-alb"
  description = "OpenWiki load balancer"
  vpc_id      = var.vpc_id

  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

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

resource "aws_security_group" "service" {
  name        = "${var.name}-service"
  description = "OpenWiki ECS service"
  vpc_id      = var.vpc_id

  ingress {
    from_port       = local.port
    to_port         = local.port
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "efs" {
  name        = "${var.name}-efs"
  description = "OpenWiki EFS"
  vpc_id      = var.vpc_id

  ingress {
    from_port       = 2049
    to_port         = 2049
    protocol        = "tcp"
    security_groups = [aws_security_group.service.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_efs_file_system" "openwiki" {
  encrypted = true
  tags = {
    Name = var.name
  }
}

resource "aws_efs_mount_target" "openwiki" {
  for_each        = toset(var.subnet_ids)
  file_system_id  = aws_efs_file_system.openwiki.id
  subnet_id       = each.value
  security_groups = [aws_security_group.efs.id]
}

resource "aws_lb" "openwiki" {
  name               = var.name
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = var.subnet_ids
}

resource "aws_lb_target_group" "openwiki" {
  name        = var.name
  port        = local.port
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = var.vpc_id

  health_check {
    path                = "/readyz"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 5
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.openwiki.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = var.certificate_arn == "" ? "forward" : "redirect"
    target_group_arn = var.certificate_arn == "" ? aws_lb_target_group.openwiki.arn : null

    dynamic "redirect" {
      for_each = var.certificate_arn == "" ? [] : [1]
      content {
        port        = "443"
        protocol    = "HTTPS"
        status_code = "HTTP_301"
      }
    }
  }
}

resource "aws_lb_listener" "https" {
  count             = var.certificate_arn == "" ? 0 : 1
  load_balancer_arn = aws_lb.openwiki.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.openwiki.arn
  }
}

data "aws_iam_policy_document" "ecs_tasks" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${var.name}-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution_runtime_secrets" {
  statement {
    sid = "ReadRuntimeSecrets"
    actions = [
      "secretsmanager:GetSecretValue",
      "ssm:GetParameters",
    ]
    resources = local.runtime_secret_arns
  }

  dynamic "statement" {
    for_each = length(var.runtime_secret_kms_key_arns) == 0 ? [] : [1]

    content {
      sid       = "DecryptRuntimeSecrets"
      actions   = ["kms:Decrypt"]
      resources = var.runtime_secret_kms_key_arns

      condition {
        test     = "StringEquals"
        variable = "kms:ViaService"
        values = [
          "secretsmanager.${var.region}.amazonaws.com",
          "ssm.${var.region}.amazonaws.com",
        ]
      }
    }
  }
}

resource "aws_iam_role_policy" "execution_runtime_secrets" {
  name   = "${var.name}-execution-runtime-secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_runtime_secrets.json
}

resource "aws_ecs_task_definition" "openwiki" {
  family                   = var.name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.execution.arn

  container_definitions = jsonencode([
    {
      name      = "openwiki"
      image     = var.image
      essential = true
      portMappings = [
        {
          containerPort = local.port
          protocol      = "tcp"
        }
      ]
      environment = [
        { name = "OPENWIKI_ROOT", value = "/data/wiki" },
        { name = "OPENWIKI_TITLE", value = var.openwiki_title },
        { name = "OPENWIKI_HOST", value = "0.0.0.0" },
        { name = "OPENWIKI_PORT", value = tostring(local.port) },
        { name = "OPENWIKI_RUNTIME_MODE", value = "hosted" },
        { name = "OPENWIKI_PUBLIC_ORIGIN", value = var.public_origin },
        { name = "OPENWIKI_READ_BACKEND", value = "postgres" },
        { name = "OPENWIKI_SEARCH_BACKEND", value = "postgres" },
        { name = "OPENWIKI_QUEUE_BACKEND", value = "postgres" },
        { name = "OPENWIKI_OPERATIONAL_STATE_BACKEND", value = "postgres" },
        { name = "OPENWIKI_WRITE_COORDINATOR_BACKEND", value = "postgres" },
        { name = "OPENWIKI_REQUIRE_AUTH", value = "true" },
        { name = "OPENWIKI_TRUST_AUTH_HEADERS", value = "1" }
      ]
      secrets = [
        {
          name      = "DATABASE_URL"
          valueFrom = var.database_url_secret_arn
        },
        {
          name      = "OPENWIKI_TRUST_AUTH_HEADERS_SECRET"
          valueFrom = var.trusted_auth_headers_secret_arn
        }
      ]
      mountPoints = [
        {
          sourceVolume  = "wiki-data"
          containerPath = "/data/wiki"
          readOnly      = false
        }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.openwiki.name
          awslogs-region        = var.region
          awslogs-stream-prefix = "openwiki"
        }
      }
    }
  ])

  volume {
    name = "wiki-data"

    efs_volume_configuration {
      file_system_id     = aws_efs_file_system.openwiki.id
      transit_encryption = "ENABLED"
    }
  }
}

resource "aws_ecs_task_definition" "openwiki_worker" {
  family                   = "${var.name}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.execution.arn

  container_definitions = jsonencode([
    {
      name      = "openwiki-worker"
      image     = var.image
      essential = true
      command = [
        "sh",
        "-ec",
        "until [ -f /data/wiki/openwiki.json ]; do echo 'Waiting for OpenWiki workspace bootstrap before starting worker'; sleep 5; done; exec node --no-warnings --import tsx /app/packages/cli/src/main.ts --root /data/wiki worker --poll-ms 1000"
      ]
      environment = [
        { name = "OPENWIKI_ROOT", value = "/data/wiki" },
        { name = "OPENWIKI_BOOTSTRAP_MODE", value = "skip" },
        { name = "OPENWIKI_RUNTIME_MODE", value = "hosted" },
        { name = "OPENWIKI_PUBLIC_ORIGIN", value = var.public_origin },
        { name = "OPENWIKI_READ_BACKEND", value = "postgres" },
        { name = "OPENWIKI_SEARCH_BACKEND", value = "postgres" },
        { name = "OPENWIKI_QUEUE_BACKEND", value = "postgres" },
        { name = "OPENWIKI_OPERATIONAL_STATE_BACKEND", value = "postgres" },
        { name = "OPENWIKI_WRITE_COORDINATOR_BACKEND", value = "postgres" },
        { name = "OPENWIKI_REQUIRE_AUTH", value = "true" },
        { name = "OPENWIKI_TRUST_AUTH_HEADERS", value = "1" }
      ]
      secrets = [
        {
          name      = "DATABASE_URL"
          valueFrom = var.database_url_secret_arn
        },
        {
          name      = "OPENWIKI_TRUST_AUTH_HEADERS_SECRET"
          valueFrom = var.trusted_auth_headers_secret_arn
        }
      ]
      mountPoints = [
        {
          sourceVolume  = "wiki-data"
          containerPath = "/data/wiki"
          readOnly      = false
        }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.openwiki.name
          awslogs-region        = var.region
          awslogs-stream-prefix = "openwiki-worker"
        }
      }
    }
  ])

  volume {
    name = "wiki-data"

    efs_volume_configuration {
      file_system_id     = aws_efs_file_system.openwiki.id
      transit_encryption = "ENABLED"
    }
  }
}

resource "aws_ecs_service" "openwiki" {
  name            = var.name
  cluster         = aws_ecs_cluster.openwiki.id
  task_definition = aws_ecs_task_definition.openwiki.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = [aws_security_group.service.id]
    assign_public_ip = var.assign_public_ip
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.openwiki.arn
    container_name   = "openwiki"
    container_port   = local.port
  }

  depends_on = [
    aws_lb_listener.http,
    aws_lb_listener.https,
    aws_efs_mount_target.openwiki
  ]
}

resource "aws_ecs_service" "openwiki_worker" {
  name            = "${var.name}-worker"
  cluster         = aws_ecs_cluster.openwiki.id
  task_definition = aws_ecs_task_definition.openwiki_worker.arn
  desired_count   = var.worker_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = [aws_security_group.service.id]
    assign_public_ip = var.assign_public_ip
  }

  depends_on = [
    aws_ecs_service.openwiki,
    aws_efs_mount_target.openwiki
  ]
}
