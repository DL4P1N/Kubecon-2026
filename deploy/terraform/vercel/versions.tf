terraform {
  required_version = ">= 1.8, < 2.0"

  required_providers {
    vercel = {
      source  = "vercel/vercel"
      version = "~> 5.26"
    }
    local = {
      source  = "hashicorp/local"
      version = "~> 2.9"
    }
  }
}

# VERCEL_API_TOKEN is read by the provider from its standard environment variable.
provider "vercel" {}
