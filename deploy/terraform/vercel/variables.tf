variable "project_name" {
  description = "Name for a newly created Vercel project owned by the caller."
  type        = string

  validation {
    condition     = length(trimspace(var.project_name)) > 0
    error_message = "project_name must not be empty."
  }
}

variable "team_id" {
  description = "Optional Vercel team ID to own the new project; omit for the personal account."
  type        = string
  default     = null
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
