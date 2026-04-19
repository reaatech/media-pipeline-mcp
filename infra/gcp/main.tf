terraform {
  required_version = ">= 1.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "region" {
  description = "GCP region"
  type        = string
  default     = "us-central1"
}

variable "environment" {
  description = "Environment name (dev, staging, prod)"
  type        = string
  default     = "prod"
}

variable "app_name" {
  description = "Application name"
  type        = string
  default     = "media-pipeline-mcp"
}

variable "docker_image" {
  description = "Docker image URI for the application"
  type        = string
}

variable "artifact_retention_days" {
  description = "Number of days before artifacts are deleted"
  type        = number
  default     = 7
}

variable "cpu" {
  description = "CPU allocation (1 = 1 vCPU)"
  type        = number
  default     = 1
}

variable "memory" {
  description = "Memory in MiB"
  type        = number
  default     = 1024
}

variable "max_instances" {
  description = "Maximum number of instances"
  type        = number
  default     = 10
}

locals {
  name_prefix = "${var.app_name}-${var.environment}"
}

# Cloud Run Service
resource "google_cloud_run_service" "main" {
  name     = local.name_prefix
  location = var.region

  template {
    spec {
      container_concurrency = 80
      timeout_seconds       = 300

      containers {
        image = var.docker_image
        ports {
          name           = "http"
          container_port = 8080
        }
        env {
          name  = "NODE_ENV"
          value = var.environment
        }
        env {
          name  = "STORAGE_TYPE"
          value = "gcs"
        }
        env {
          name  = "GCS_BUCKET"
          value = google_storage_bucket.artifacts.name
        }
        env {
          name  = "LOG_LEVEL"
          value = var.environment == "prod" ? "info" : "debug"
        }
        env {
          name  = "OTEL_EXPORTER_OTLP_ENDPOINT"
          value = "grpc://cloudtrace.googleapis.com:443"
        }
        resources {
          limits = {
            cpu    = "${var.cpu}"
            memory = "${var.memory}Mi"
          }
        }
      }
    }

    metadata {
      annotations = {
        "autoscaling.knative.dev/maxInstances" = var.max_instances
        "run.googleapis.com/cloudsql-instances"  = ""
      }
    }
  }

  traffic {
    percent         = 100
    latest_revision = true
  }

  depends_on = [google_storage_bucket_iam_member.service-account-storage]
}

resource "google_cloud_run_service_iam_member" "public" {
  service  = google_cloud_run_service.main.name
  location = google_cloud_run_service.main.location
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# Cloud Storage Bucket for artifacts
resource "google_storage_bucket" "artifacts" {
  name          = "${local.name_prefix}-artifacts-${var.project_id}"
  location      = var.region
  force_destroy = false

  uniform_bucket_level_access = true

  lifecycle_rule {
    condition {
      age = var.artifact_retention_days
    }
    action {
      type = "Delete"
    }
  }

  versioning {
    enabled = false
  }

  encryption {
    default_kms_key_name = ""
  }
}

resource "google_storage_bucket_iam_member" "service-account-storage" {
  bucket = google_storage_bucket.artifacts.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.cloudrun-sa.email}"
}

# Service Account for Cloud Run
resource "google_service_account" "cloudrun-sa" {
  account_id   = "${local.name_prefix}-sa"
  display_name = "Cloud Run service account for ${var.app_name}"
}

# Secret Manager for API keys
resource "google_secret_manager_secret" "api_keys" {
  secret_id = "${local.name_prefix}-api-keys"

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "api_keys" {
  secret      = google_secret_manager_secret.api_keys.id
  secret_data = "placeholder" # Update with actual API keys via gcloud or API
}

resource "google_secret_manager_secret_iam_member" "access" {
  secret_id = google_secret_manager_secret.api_keys.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.cloudrun-sa.email}"
}

# Cloud Trace permissions
resource "google_project_iam_member" "cloudtrace" {
  project = var.project_id
  role    = "roles/cloudtrace.agent"
  member  = "serviceAccount:${google_service_account.cloudrun-sa.email}"
}

# Cloud Monitoring permissions
resource "google_project_iam_member" "monitoring" {
  project = var.project_id
  role    = "roles/monitoring.metricWriter"
  member  = "serviceAccount:${google_service_account.cloudrun-sa.email}"
}

# Cloud Monitoring Dashboard
resource "google_monitoring_dashboard" "main" {
  dashboard_json = jsonencode({
    displayName = "${var.app_name} - ${var.environment}"
    gridLayout = {
      columns = "2"
      widgets = [
        {
          title = "Request Count"
          xyChart = {
            dataSets = [{
              timeSeriesQuery = {
                timeSeriesFilter = {
                  filter = "resource.type=\"cloud_run_revision\" AND resource.label.\"service_name\"=\"${google_cloud_run_service.main.name}\" AND metric.type=\"run.googleapis.com/request_count\""
                }
              }
            }]
          }
        },
        {
          title = "Response Latency"
          xyChart = {
            dataSets = [{
              timeSeriesQuery = {
                timeSeriesFilter = {
                  filter = "resource.type=\"cloud_run_revision\" AND resource.label.\"service_name\"=\"${google_cloud_run_service.main.name}\" AND metric.type=\"run.googleapis.com/response_latencies\""
                }
              }
            }]
          }
        },
        {
          title = "CPU Utilization"
          xyChart = {
            dataSets = [{
              timeSeriesQuery = {
                timeSeriesFilter = {
                  filter = "resource.type=\"cloud_run_revision\" AND resource.label.\"service_name\"=\"${google_cloud_run_service.main.name}\" AND metric.type=\"run.googleapis.com/container/cpu/utilizations\""
                }
              }
            }]
          }
        },
        {
          title = "Memory Utilization"
          xyChart = {
            dataSets = [{
              timeSeriesQuery = {
                timeSeriesFilter = {
                  filter = "resource.type=\"cloud_run_revision\" AND resource.label.\"service_name\"=\"${google_cloud_run_service.main.name}\" AND metric.type=\"run.googleapis.com/container/memory/utilizations\""
                }
              }
            }]
          }
        }
      ]
    }
  })
}

# Outputs
output "service_url" {
  description = "URL of the Cloud Run service"
  value       = google_cloud_run_service.main.status[0].url
}

output "bucket_name" {
  description = "Name of the GCS bucket for artifacts"
  value       = google_storage_bucket.artifacts.name
}

output "secret_name" {
  description = "Name of the Secret Manager secret for API keys"
  value       = google_secret_manager_secret.api_keys.secret_id
}

output "service_account" {
  description = "Service account email"
  value       = google_service_account.cloudrun-sa.email
}
