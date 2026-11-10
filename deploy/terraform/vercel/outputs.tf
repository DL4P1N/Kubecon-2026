output "deployment_url" {
  description = "Immutable URL for this specific production deployment; do not register it as a stable OAuth redirect."
  value       = vercel_deployment.frontend.url
}

output "production_domain_urls" {
  description = "HTTPS URLs for the aliases assigned to this production deployment; use the project's stable production alias for OAuth callbacks."
  value       = [for domain in vercel_deployment.frontend.domains : "https://${domain}"]
}

output "project_id" {
  description = "ID of the newly created Vercel project."
  value       = vercel_project.frontend.id
}
