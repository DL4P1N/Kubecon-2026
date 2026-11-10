variable "project_name" {
  description = "Name for a newly created Vercel project owned by the caller."
  type        = string

  validation {
    condition     = length(trimspace(var.project_name)) > 0
    error_message = "project_name must not be empty."
  }
}

variable "team_id" {
  description = "Vercel team ID (team_…) that owns the new project. Every Vercel account, including Hobby, has one; find it under Team Settings → General or with `vercel teams ls`. Required: leaving it to the token's default team makes the provider's stored identity drift on the next refresh."
  type        = string

  validation {
    condition     = can(regex("^team_[A-Za-z0-9]+$", var.team_id))
    error_message = "team_id must be a Vercel team ID such as team_abc123."
  }
}

variable "backend_origin" {
  description = "Publicly reachable HTTPS origin for the separately operated Kubernetes backend."
  type        = string

  validation {
    condition     = can(regex("^https://[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::[0-9]{1,5})?$", trimsuffix(var.backend_origin, "/")))
    error_message = "backend_origin must be an HTTPS origin only: no credentials, path, query, or fragment."
  }
}

variable "artifact_directory" {
  description = "Absolute or module-relative path to the built static artifact directory."
  type        = string
  default     = "artifacts"
}
