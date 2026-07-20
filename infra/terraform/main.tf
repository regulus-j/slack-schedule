locals {
  service_name   = "slack-scheduler"
  app_sa_name    = "scheduler-runtime"
  db_sa_name     = "scheduler-postgres"
  backup_sa_name = "scheduler-backup"
  secret_ids     = var.secret_names
}

resource "google_project_service" "apis" {
  for_each           = toset(["artifactregistry.googleapis.com", "compute.googleapis.com", "iamcredentials.googleapis.com", "logging.googleapis.com", "monitoring.googleapis.com", "run.googleapis.com", "secretmanager.googleapis.com", "storage.googleapis.com", "vpcaccess.googleapis.com", "cloudscheduler.googleapis.com", "serviceusage.googleapis.com"])
  service            = each.value
  disable_on_destroy = false
}

resource "google_artifact_registry_repository" "app" {
  location      = var.region
  repository_id = "slack-scheduler-image"
  format        = "DOCKER"
  depends_on    = [google_project_service.apis]
}

resource "google_compute_network" "private" {
  name                    = "${local.service_name}-${var.environment}"
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "app" {
  name          = "${local.service_name}-app"
  region        = var.region
  network       = google_compute_network.private.id
  ip_cidr_range = "10.20.0.0/24"
}

resource "google_service_account" "app" {
  account_id   = local.app_sa_name
  display_name = "Slack Scheduler runtime"
}

resource "google_service_account" "db" {
  account_id   = local.db_sa_name
  display_name = "Slack Scheduler PostgreSQL"
}

resource "google_service_account" "backup" {
  account_id   = local.backup_sa_name
  display_name = "Slack Scheduler PostgreSQL backups"
}

resource "google_storage_bucket" "backups" {
  name                        = "${var.project_id}-${local.service_name}-postgres-backups"
  location                    = var.region
  uniform_bucket_level_access = true
  force_destroy               = false
  lifecycle_rule {
    condition {
      age = var.backup_retention_days
    }
    action {
      type = "Delete"
    }
  }
}

resource "google_storage_bucket_iam_member" "backup_writer" {
  bucket = google_storage_bucket.backups.name
  role   = "roles/storage.objectCreator"
  member = "serviceAccount:${google_service_account.backup.email}"
}

resource "google_secret_manager_secret" "app" {
  for_each  = local.secret_ids
  secret_id = "${each.value}-${var.environment}"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_iam_member" "app_access" {
  for_each  = google_secret_manager_secret.app
  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.app.email}"
}
resource "google_secret_manager_secret_iam_member" "db_password_access" {
  secret_id = google_secret_manager_secret.app["DATABASE_PASSWORD"].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.db.email}"
}

resource "google_kms_key_ring" "app" {
  name     = "${local.service_name}-${var.environment}"
  location = var.region
}
resource "google_kms_crypto_key" "oauth_tokens" {
  name            = "oauth-token-encryption"
  key_ring        = google_kms_key_ring.app.id
  rotation_period = "7776000s"
  lifecycle { prevent_destroy = true }
}
resource "google_kms_crypto_key_iam_member" "app" {
  crypto_key_id = google_kms_crypto_key.oauth_tokens.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${google_service_account.app.email}"
}

resource "google_compute_address" "db" {
  name         = "${local.service_name}-${var.environment}-db"
  address_type = "INTERNAL"
  subnetwork   = google_compute_subnetwork.app.id
  region       = var.region
}

resource "google_compute_firewall" "iap_ssh" {
  name    = "${local.service_name}-${var.environment}-iap-ssh"
  network = google_compute_network.private.name
  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
  source_ranges = ["35.235.240.0/20"]
  target_tags   = ["slack-scheduler-ssh"]
}
resource "google_compute_firewall" "postgres" {
  name    = "${local.service_name}-${var.environment}-postgres"
  network = google_compute_network.private.name
  allow {
    protocol = "tcp"
    ports    = ["5432"]
  }
  source_ranges = ["10.8.0.0/28"]
  target_tags   = ["slack-scheduler-db"]
}

resource "google_compute_instance" "db" {
  name         = "${local.service_name}-${var.environment}-db"
  machine_type = var.db_machine_type
  zone         = "${var.region}-a"
  tags         = ["slack-scheduler-db", "slack-scheduler-ssh"]
  boot_disk {
    initialize_params {
      image = "ubuntu-os-cloud/ubuntu-2404-lts-amd64"
      size  = 20
      type  = "pd-balanced"
    }
  }
  attached_disk { source = google_compute_disk.db_data.id }
  network_interface { subnetwork = google_compute_subnetwork.app.id }
  service_account {
    email  = google_service_account.db.email
    scopes = ["cloud-platform"]
  }
  metadata = { startup-script = templatefile("${path.module}/postgres-startup-script.tftpl", { db_ip = google_compute_address.db.address, db_name = var.database_name, db_user = var.database_user, db_password_secret = google_secret_manager_secret.app["DATABASE_PASSWORD"].secret_id, backup_bucket = google_storage_bucket.backups.name }) }
}
resource "google_compute_disk" "db_data" {
  name = "${local.service_name}-${var.environment}-db-data"
  type = "pd-balanced"
  zone = "${var.region}-a"
  size = var.db_disk_gb
}

resource "google_project_iam_member" "backup_logging" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.backup.email}"
}

resource "google_vpc_access_connector" "run" {
  name          = "ss-${var.environment}"
  region        = var.region
  network       = google_compute_network.private.name
  ip_cidr_range = "10.8.0.0/28"
  min_instances = 2
  max_instances = 3
}

resource "google_cloud_run_v2_service" "app" {
  name                 = local.service_name
  location             = var.region
  deletion_protection  = var.environment == "production"
  invoker_iam_disabled = true
  template {
    service_account = google_service_account.app.email
    scaling {
      min_instance_count = 0
      max_instance_count = 1
    }
    max_instance_request_concurrency = 80
    containers {
      image = var.container_image
      resources {
        limits   = { cpu = "1", memory = "512Mi" }
        cpu_idle = false
      }
      ports { container_port = 3000 }
      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "DATABASE_BACKEND"
        value = "postgres"
      }
      env {
        name  = "DATABASE_SSL_MODE"
        value = "no-verify"
      }
      env {
        name  = "GOOGLE_KMS_KEY_NAME"
        value = google_kms_crypto_key.oauth_tokens.id
      }
      env {
        name  = "PUBLIC_BASE_URL"
        value = var.public_base_url
      }
      env {
        name  = "SLACK_TEAM_ID"
        value = var.slack_team_id
      }
      env {
        name  = "SLACK_POSTING_CHANNEL_ID"
        value = var.slack_posting_channel_id
      }
      env {
        name  = "SLACK_RECRUITMENT_USER_IDS"
        value = var.slack_recruitment_user_ids
      }
      env {
        name  = "SLACK_ADMIN_USER_IDS"
        value = var.slack_admin_user_ids
      }
      env {
        name  = "SLACK_ALERT_USER_IDS"
        value = var.slack_alert_user_ids
      }
      env {
        name  = "ACCESS_CONTROL_ENFORCED"
        value = "true"
      }
      env {
        name  = "GOOGLE_CLIENT_ID"
        value = var.google_client_id
      }
      env {
        name  = "GOOGLE_REDIRECT_URI"
        value = var.google_redirect_uri
      }
      env {
        name  = "GOOGLE_SHARED_CALENDAR_ID"
        value = var.google_shared_calendar_id
      }
      env {
        name  = "GOOGLE_AUTH_SLACK_USER_ID"
        value = var.google_auth_slack_user_id
      }
      dynamic "env" {
        for_each = ["DATABASE_URL", "SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "JAZZHR_API_KEY", "GOOGLE_CLIENT_SECRET", "RECRUITER_PHONE_EXPORT_TOKEN", "ROLE_ASSIGNMENT_EXPORT_TOKEN"]
        content {
          name = env.value
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.app[env.value].secret_id
              version = "latest"
            }
          }
        }
      }
    }
    vpc_access {
      connector = google_vpc_access_connector.run.id
      egress    = "PRIVATE_RANGES_ONLY"
    }
  }
  depends_on = [google_secret_manager_secret_iam_member.app_access]
}

resource "google_cloud_run_v2_job" "migrate" {
  name     = "${local.service_name}-migrate"
  location = var.region
  template {
    template {
      service_account = google_service_account.app.email
      containers {
        image   = var.container_image
        command = ["npm", "run", "migrate"]
        env {
          name  = "NODE_ENV"
          value = "production"
        }
        env {
          name  = "DATABASE_BACKEND"
          value = "postgres"
        }
        env {
          name  = "DATABASE_SSL_MODE"
          value = "no-verify"
        }
        env {
          name  = "GOOGLE_KMS_KEY_NAME"
          value = google_kms_crypto_key.oauth_tokens.id
        }
        env {
          name = "DATABASE_URL"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.app["DATABASE_URL"].secret_id
              version = "latest"
            }
          }
        }
      }
      vpc_access {
        connector = google_vpc_access_connector.run.id
        egress    = "PRIVATE_RANGES_ONLY"
      }
    }
  }
}

resource "google_cloud_run_v2_job" "retention" {
  name     = "${local.service_name}-retention"
  location = var.region
  template {
    template {
      service_account = google_service_account.app.email
      containers {
        image   = var.container_image
        command = ["npm", "run", "retention"]
        env {
          name  = "NODE_ENV"
          value = "production"
        }
        env {
          name  = "DATABASE_BACKEND"
          value = "postgres"
        }
        env {
          name  = "DATABASE_SSL_MODE"
          value = "no-verify"
        }
        env {
          name  = "GOOGLE_KMS_KEY_NAME"
          value = google_kms_crypto_key.oauth_tokens.id
        }
        env {
          name = "DATABASE_URL"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.app["DATABASE_URL"].secret_id
              version = "latest"
            }
          }
        }
      }
      vpc_access {
        connector = google_vpc_access_connector.run.id
        egress    = "PRIVATE_RANGES_ONLY"
      }
    }
  }
}

resource "google_service_account" "scheduler" {
  account_id   = "scheduler-jobs"
  display_name = "Slack Scheduler schedule control"
}
resource "google_project_iam_member" "scheduler_compute" {
  project = var.project_id
  role    = "roles/compute.instanceAdmin.v1"
  member  = "serviceAccount:${google_service_account.scheduler.email}"
}
resource "google_project_iam_member" "scheduler_run" {
  project = var.project_id
  role    = "roles/run.admin"
  member  = "serviceAccount:${google_service_account.scheduler.email}"
}
resource "google_project_iam_member" "scheduler_invoker" {
  project = var.project_id
  role    = "roles/run.invoker"
  member  = "serviceAccount:${google_service_account.scheduler.email}"
}
resource "google_cloud_scheduler_job" "db_start" {
  name      = "${local.service_name}-db-start"
  region    = var.region
  schedule  = "30 8 * * 1-5"
  time_zone = "Australia/Sydney"
  http_target {
    uri         = "https://compute.googleapis.com/compute/v1/projects/${var.project_id}/zones/${var.region}-a/instances/${google_compute_instance.db.name}/start"
    http_method = "POST"
    oauth_token { service_account_email = google_service_account.scheduler.email }
  }
}
resource "google_cloud_scheduler_job" "run_on" {
  name      = "${local.service_name}-run-on"
  region    = var.region
  schedule  = "45 8 * * 1-5"
  time_zone = "Australia/Sydney"
  http_target {
    uri         = "https://run.googleapis.com/v2/projects/${var.project_id}/locations/${var.region}/services/${google_cloud_run_v2_service.app.name}?updateMask=template.scaling.minInstanceCount"
    http_method = "PATCH"
    body        = base64encode(jsonencode({ template = { scaling = { minInstanceCount = 1 } } }))
    headers     = { "Content-Type" = "application/json" }
    oauth_token { service_account_email = google_service_account.scheduler.email }
  }
}
resource "google_cloud_scheduler_job" "run_off" {
  name      = "${local.service_name}-run-off"
  region    = var.region
  schedule  = "30 18 * * 1-5"
  time_zone = "Australia/Sydney"
  http_target {
    uri         = "https://run.googleapis.com/v2/projects/${var.project_id}/locations/${var.region}/services/${google_cloud_run_v2_service.app.name}?updateMask=template.scaling.minInstanceCount"
    http_method = "PATCH"
    body        = base64encode(jsonencode({ template = { scaling = { minInstanceCount = 0 } } }))
    headers     = { "Content-Type" = "application/json" }
    oauth_token { service_account_email = google_service_account.scheduler.email }
  }
}
resource "google_cloud_scheduler_job" "db_stop" {
  name      = "${local.service_name}-db-stop"
  region    = var.region
  schedule  = "0 19 * * 1-5"
  time_zone = "Australia/Sydney"
  http_target {
    uri         = "https://compute.googleapis.com/compute/v1/projects/${var.project_id}/zones/${var.region}-a/instances/${google_compute_instance.db.name}/stop"
    http_method = "POST"
    oauth_token { service_account_email = google_service_account.scheduler.email }
  }
}
resource "google_cloud_scheduler_job" "retention" {
  name      = "${local.service_name}-retention"
  region    = var.region
  schedule  = "0 17 * * 1-5"
  time_zone = "Australia/Sydney"
  http_target {
    uri         = "https://run.googleapis.com/v2/projects/${var.project_id}/locations/${var.region}/jobs/${google_cloud_run_v2_job.retention.name}:run"
    http_method = "POST"
    oauth_token { service_account_email = google_service_account.scheduler.email }
  }
}

resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "github-actions"
  display_name              = "GitHub Actions"
}
resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  display_name                       = "GitHub"
  attribute_mapping                  = { "google.subject" = "assertion.sub", "attribute.repository" = "assertion.repository" }
  attribute_condition                = "assertion.repository == '${var.github_repository}'"
  oidc { issuer_uri = "https://token.actions.githubusercontent.com" }
}
resource "google_service_account" "deploy" {
  account_id   = "scheduler-deploy"
  display_name = "Slack Scheduler deployment"
}
resource "google_service_account_iam_member" "github_deploy" {
  service_account_id = google_service_account.deploy.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_repository}"
}
resource "google_project_iam_member" "deploy_roles" {
  for_each = toset(["roles/artifactregistry.writer", "roles/compute.instanceAdmin.v1", "roles/compute.networkAdmin", "roles/iam.serviceAccountUser", "roles/resourcemanager.projectIamAdmin", "roles/secretmanager.admin", "roles/serviceusage.serviceUsageAdmin"])
  project  = var.project_id
  role     = each.value
  member   = "serviceAccount:${google_service_account.deploy.email}"
}
