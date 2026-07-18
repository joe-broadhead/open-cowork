output "url" {
  description = "OpenWiki URL."
  value       = var.certificate_arn == "" ? "http://${aws_lb.openwiki.dns_name}" : "https://${aws_lb.openwiki.dns_name}"
}

output "efs_file_system_id" {
  description = "EFS file system used for /data/wiki."
  value       = aws_efs_file_system.openwiki.id
}
