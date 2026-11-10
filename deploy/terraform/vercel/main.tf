locals {
  backend_origin = trimsuffix(var.backend_origin, "/")
  vercel_config = {
    routes = [
      { src = "^/$", status = 302, headers = { Location = "/site/" } },
      { src = "^/site$", status = 302, headers = { Location = "/site/" } },
      { src = "^/api/(.*)$", dest = "${local.backend_origin}/api/$1", headers = { "Cache-Control" = "private, no-store" } },
      { src = "^/site/api/(.*)$", dest = "${local.backend_origin}/api/$1", headers = { "Cache-Control" = "private, no-store" } },
      { src = "^/otlp/(.*)$", dest = "${local.backend_origin}/otlp/$1" },
      { src = "^/healthz$", dest = "${local.backend_origin}/healthz" },
      { src = "^/site/passes/.+\\.pkpass$", headers = { "Content-Type" = "application/vnd.apple.pkpass" }, continue = true },
      { handle = "filesystem" },
      { src = "^/site(?:/.*)?$", dest = "/site/index.html" },
      { src = "^/(.*)$", dest = "/index.html" },
    ]
  }
}

resource "vercel_project" "frontend" {
  name                                              = var.project_name
  team_id                                           = var.team_id
  framework                                         = null
  directory_listing                                 = false
  automatically_expose_system_environment_variables = false
  preview_deployments_disabled                      = true
  manage_deployment_protection                      = true
  vercel_authentication = {
    deployment_type = "none"
  }
}

resource "local_file" "vercel_routes" {
  filename             = "${var.artifact_directory}/vercel.json"
  content              = jsonencode(local.vercel_config)
  file_permission      = "0644"
  directory_permission = "0755"
}

data "vercel_project_directory" "frontend" {
  path       = var.artifact_directory
  depends_on = [local_file.vercel_routes]

  lifecycle {
    precondition {
      condition = (
        fileexists("${var.artifact_directory}/index.html") &&
        fileexists("${var.artifact_directory}/site/index.html")
      )
      error_message = "Build the static artifact with node deploy/terraform/vercel/build-artifact.mjs before planning a deployment."
    }
  }
}

resource "vercel_deployment" "frontend" {
  project_id        = vercel_project.frontend.id
  team_id           = var.team_id
  files             = data.vercel_project_directory.frontend.files
  path_prefix       = data.vercel_project_directory.frontend.path
  production        = true
  delete_on_destroy = true
}
