# Optional Vercel frontend

This module creates a **new** Vercel project and uploads a static artifact from `web/Dockerfile`. It does not connect an existing project, upload the repository, manage Kubernetes/Elasticsearch, or create a domain. Terraform uses `vercel/vercel` `~> 5.26` and `hashicorp/local` `~> 2.9`: the local provider writes public `vercel.json` routing from the Terraform `backend_origin` input, then the Vercel project-directory data source reads the complete artifact and the deployment resource uploads it. The deployment depends on both its project and generated artifact. The first deployment is production and `delete_on_destroy` removes that Vercel deployment. Destroying the project removes the project and its Vercel deployments; this is not a backup/retention mechanism.

Provider documentation for the pinned major/minor constraints: [Vercel deployment resource](https://registry.terraform.io/providers/vercel/vercel/5.26.1/docs/resources/deployment), [Vercel project resource](https://registry.terraform.io/providers/vercel/vercel/5.26.1/docs/resources/project), [Vercel project-directory data source](https://registry.terraform.io/providers/vercel/vercel/5.26.1/docs/data-sources/project_directory), and [HashiCorp local file resource](https://registry.terraform.io/providers/hashicorp/local/2.9.1/docs/resources/file).

## Prerequisites and build

- Docker, Node.js, Terraform >= 1.8, and an existing Vercel account/API token.
- A running Kubernetes backend exposed at a **reachable HTTPS origin**. For a laptop cluster, use an operator-managed HTTPS tunnel. The tunnel, laptop, Kubernetes cluster, and backend must stay available. SSE (`/api/events`) requires a tunnel/proxy that supports long-lived streaming and disables buffering.
- This deployment is optional. Local-only users should use `node deploy/local/companion.mjs` (see [`deploy/local/README.md`](../../local/README.md)) without applying this Terraform module.

Build only the web image's `/usr/share/nginx/html` into this module's `artifacts/` directory. The helper removes/replaces that output. It does not copy source files, repository content, `.env`, credentials, kubeconfigs, or Terraform state:

```sh
node deploy/terraform/vercel/build-artifact.mjs
```

The command builds `web/Dockerfile` from the repo root and copies only its static asset directory. Terraform generates `vercel.json` from the single required `backend_origin` input, so changing the origin updates the next plan/deployment. Do not hand-edit the generated file.

## Configure and deploy

Set `VERCEL_API_TOKEN` in the environment from your own Vercel token. The provider reads only its standard environment variable; do not put tokens in tfvars, Terraform configuration, shell history, or Vercel project environment. Restrict token scope and revoke it when no longer needed. Terraform state is local by default and records project/deployment metadata; keep the state and `.terraform/` private and untracked.

Create a private `terraform.tfvars` in this directory (never commit it):

```hcl
project_name      = "my-conference-companion"
# Optional; omit for a personal Vercel account.
# team_id          = "your-team-id"
backend_origin    = "https://your-reachable-backend.example"
artifact_directory = "artifacts"
```

OAuth callback registration: use the project's stable production alias from `terraform output -json production_domain_urls` (not the immutable `deployment_url`) and register `https://<stable-alias>/auth/<provider>/callback` with each enabled provider. Set the matching backend `*_OAUTH_REDIRECT_URI` to that same public URL; OAuth client credentials belong only in backend runtime environment, not this module. The browser callback page posts its result to `/api/auth/:provider/callback`.

Run from `deploy/terraform/vercel`:

```sh
terraform init
terraform validate
terraform plan
terraform apply
terraform output -json production_domain_urls
```
`.terraform.lock.hcl` is committed so `terraform init` installs the same provider builds; run `terraform init -upgrade` only when deliberately moving within the version constraints, then review and commit the lock change. Never commit `.terraform/` or state.

Terraform validate needs no Vercel credentials; plan/apply require a valid token and account access. The project name must be unused within the selected account/team. Review plan and confirm it creates only the new Vercel project and deployment.

To remove this deployment and project:

```sh
terraform destroy
```

This is destructive to the Terraform-owned Vercel project/deployment. Back up any needed state first; do not destroy an existing manually managed Vercel project.

## Routes and operational constraints

Generated routing redirects `/` and `/site` to `/site/`; proxies `/api/*` and `/site/api/*` to backend `/api/*`, `/otlp/*` to `/otlp/*`, and `/healthz` to the backend. API responses use `Cache-Control: private, no-store`. Static files are served before `/site/*` falls back to `/site/index.html`, then other paths fall back to `/index.html`. `.pkpass` responses retain `application/vnd.apple.pkpass`. The root redirect is a relative path and exposes no backend origin.


Vercel account/team policy may enforce Standard Deployment Protection or other access controls independently of project configuration. Project authentication is explicitly configured as `none`, but this cannot override an account-level policy. Before claiming a public frontend works, inspect the project's/account's Deployment Protection settings and select a plan/settings that permits the required public access; if policy cannot be changed, the frontend remains protected and Terraform cannot report it as public. No preview SSO bypass or fake public-success behavior is configured.

The origin must be real and reachable from Vercel's edge, not `localhost`, a cluster-internal service name, or a private IP. Vercel hosts only static frontend assets; it does not host the backend, ES, or the tunnel. Local-only operation remains available without Vercel.

## Ignore requirements

The root `.gitignore` already excludes `deploy/terraform/vercel/artifacts/`, `.terraform/`, `*.tfstate*`, `*.tfvars` (except `*.tfvars.example`), and `*.tfplan`; the root `.dockerignore` keeps them out of image build contexts. Do not commit generated artifacts, local state, credentials, private variable files, or plans.
