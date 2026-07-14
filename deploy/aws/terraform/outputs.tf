output "web_alb_dns_name" {
  description = "ALB DNS name — point your domain's CNAME/alias here."
  value       = aws_lb.web[0].dns_name
}

output "artifact_bucket" {
  description = "S3 bucket holding cloud artifacts."
  value       = aws_s3_bucket.artifacts.bucket
}

output "database_endpoint" {
  description = "RDS endpoint for operators and migrations."
  value       = aws_db_instance.cloud.address
}

output "database_master_secret_arn" {
  description = "Secrets Manager ARN of the RDS-managed master password."
  value       = one(aws_db_instance.cloud.master_user_secret[*].secret_arn)
}

output "ecs_cluster_name" {
  description = "ECS cluster running the cloud roles."
  value       = aws_ecs_cluster.cloud.name
}

output "migrator_task_definition_arn" {
  description = "Digest-pinned one-shot migration task. Null until migrator_secret_env is configured."
  value       = try(aws_ecs_task_definition.migrator[0].arn, null)
}

output "service_security_group_id" {
  description = "Security group for the private migrator task and long-running services."
  value       = aws_security_group.service.id
}
