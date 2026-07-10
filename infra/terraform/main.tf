locals {
  service_name      = "slack-scheduler"
  database_name     = "scheduler"
  runtime_sa_name   = "scheduler-runtime"
  migrate_sa_name   = "scheduler-migrate"
  scheduler_sa_name = "scheduler-jobs"
  common_env = {
    NODE_ENV                             = "production"
    PORT                                 = "3000"
    PUBLIC_BASE_URL                      = var.public_base_url
    DATABASE_BACKEND                     = "cloudsql"
    CLOUD_SQL_INSTANCE                   = google_sql_database_instance.postgres.connection_name
    CLOUD_SQL_DATABASE                   = google_sql_database.app.name
    CLOUD_SQL_IAM_USER                   = trimsuffix(google_service_account.runtime.email, ".gserviceaccount.com")
    CLOUD_SQL_IP_TYPE                    = "PRIVATE"
    GOOGLE_KMS_KEY_NAME                  = google_kms_crypto_key.oauth_tokens.id
    SLACK_TEAM_ID                        = var.slack_team_id
    SLACK_POSTING_CHANNEL_ID             = var.slack_posting_channel_id
    SLACK_RECRUITMENT_USER_IDS           = var.slack_recruitment_user_ids
    SLACK_ADMIN_USER_IDS                 = var.slack_admin_user_ids
    SLACK_ALERT_USER_IDS                 = var.slack_alert_user_ids
    ACCESS_CONTROL_ENFORCED              = "true"
    GOOGLE_CLIENT_ID                     = var.google_client_id
    GOOGLE_REDIRECT_URI                  = var.google_redirect_uri
    GOOGLE_SHARED_CALENDAR_ID            = var.google_shared_calendar_id
    GOOGLE_AUTH_SLACK_USER_ID            = var.google_auth_slack_user_id
    RETENTION_COMPLETED_CASE_DAYS        = "365"
    RETENTION_CANDIDATE_CACHE_DAYS       = "30"
    RETENTION_GOOGLE_TOKEN_INACTIVE_DAYS = "90"
    RETENTION_OAUTH_STATE_HOURS          = "24"
  }
}

resource "google_project_service" "apis" {
  for_each = toset([
    "artifactregistry.googleapis.com",
    "cloudkms.googleapis.com",
    "cloudscheduler.googleapis.com",
    "compute.googleapis.com",
    "iamcredentials.googleapis.com",
    "iap.googleapis.com",
    "logging.googleapis.com",
    "monitoring.googleapis.com",
    "oslogin.googleapis.com",
    "pubsub.googleapis.com",
    "run.googleapis.com",
    "secretmanager.googleapis.com",
    "servicenetworking.googleapis.com",
    "sqladmin.googleapis.com",
  ])
  service            = each.value
  disable_on_destroy = false
}

resource "google_artifact_registry_repository" "app" {
  location      = var.region
  repository_id = local.service_name
  format        = "DOCKER"
  depends_on    = [google_project_service.apis]
}

resource "google_compute_network" "private" {
  name                    = "${local.service_name}-${var.environment}"
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "run" {
  name          = "${local.service_name}-run"
  region        = var.region
  network       = google_compute_network.private.id
  ip_cidr_range = "10.20.0.0/24"
}

resource "google_compute_global_address" "private_services" {
  name          = "${local.service_name}-private-services"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = google_compute_network.private.id
}

resource "google_service_networking_connection" "private_vpc" {
  network                 = google_compute_network.private.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_services.name]
  depends_on              = [google_project_service.apis]
}

resource "google_service_account" "runtime" {
  account_id   = local.runtime_sa_name
  display_name = "Slack Scheduler runtime"
}

resource "google_service_account" "migration" {
  account_id   = local.migrate_sa_name
  display_name = "Slack Scheduler migrations"
}

resource "google_service_account" "scheduler" {
  account_id   = local.scheduler_sa_name
  display_name = "Slack Scheduler scheduled jobs"
}

resource "google_sql_database_instance" "postgres" {
  name                = "${local.service_name}-${var.environment}"
  database_version    = "POSTGRES_16"
  region              = var.region
  deletion_protection = var.environment == "production"

  settings {
    tier              = var.environment == "production" ? "db-custom-2-7680" : "db-f1-micro"
    availability_type = var.environment == "production" ? "REGIONAL" : "ZONAL"
    disk_autoresize   = true
    disk_type         = "PD_SSD"

    ip_configuration {
      ipv4_enabled    = false
      private_network = google_compute_network.private.id
      ssl_mode        = "ENCRYPTED_ONLY"
    }

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
      transaction_log_retention_days = 7
      backup_retention_settings {
        retained_backups = 35
        retention_unit   = "COUNT"
      }
    }

    insights_config {
      query_insights_enabled  = true
      record_application_tags = true
    }
  }

  depends_on = [google_service_networking_connection.private_vpc]
}

resource "google_sql_database" "app" {
  name     = local.database_name
  instance = google_sql_database_instance.postgres.name
}

resource "google_sql_user" "runtime" {
  name     = trimsuffix(google_service_account.runtime.email, ".gserviceaccount.com")
  instance = google_sql_database_instance.postgres.name
  type     = "CLOUD_IAM_SERVICE_ACCOUNT"
}

resource "google_sql_user" "migration" {
  name     = trimsuffix(google_service_account.migration.email, ".gserviceaccount.com")
  instance = google_sql_database_instance.postgres.name
  type     = "CLOUD_IAM_SERVICE_ACCOUNT"
}

resource "google_secret_manager_secret" "app" {
  for_each  = var.secret_names
  secret_id = "${each.value}-${var.environment}"
  replication {
    auto {}
  }
  dynamic "rotation" {
    for_each = var.secret_next_rotation_time == "" ? [] : [1]
    content {
      rotation_period    = "7776000s"
      next_rotation_time = var.secret_next_rotation_time
    }
  }
  topics {
    name = google_pubsub_topic.secret_rotation.id
  }
}

resource "google_pubsub_topic" "secret_rotation" {
  name = "${local.service_name}-secret-rotation"
}

resource "google_project_service_identity" "secretmanager" {
  provider = google-beta
  service  = "secretmanager.googleapis.com"
}

resource "google_pubsub_topic_iam_member" "secretmanager_publisher" {
  topic  = google_pubsub_topic.secret_rotation.name
  role   = "roles/pubsub.publisher"
  member = "serviceAccount:${google_project_service_identity.secretmanager.email}"
}

resource "google_kms_key_ring" "app" {
  name     = "${local.service_name}-${var.environment}"
  location = var.region
}

resource "google_kms_crypto_key" "oauth_tokens" {
  name            = "oauth-token-encryption"
  key_ring        = google_kms_key_ring.app.id
  rotation_period = "7776000s"
  lifecycle {
    prevent_destroy = true
  }
}

resource "google_project_iam_member" "runtime_roles" {
  for_each = toset([
    "roles/cloudsql.client",
    "roles/cloudsql.instanceUser",
    "roles/logging.logWriter",
    "roles/monitoring.metricWriter",
  ])
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_project_iam_member" "migration_roles" {
  for_each = toset([
    "roles/cloudsql.client",
    "roles/cloudsql.instanceUser",
    "roles/logging.logWriter",
  ])
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.migration.email}"
}

resource "google_secret_manager_secret_iam_member" "runtime_secret_access" {
  for_each  = google_secret_manager_secret.app
  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_secret_manager_secret_iam_member" "migration_secret_access" {
  for_each  = google_secret_manager_secret.app
  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.migration.email}"
}

resource "google_kms_crypto_key_iam_member" "runtime_kms" {
  crypto_key_id = google_kms_crypto_key.oauth_tokens.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_kms_crypto_key_iam_member" "migration_kms" {
  crypto_key_id = google_kms_crypto_key.oauth_tokens.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${google_service_account.migration.email}"
}

# ── Compute Engine VM ──────────────────────────────────────────────────

resource "google_compute_address" "app" {
  name   = "${local.service_name}-${var.environment}"
  region = var.region
}

resource "google_compute_firewall" "allow_https" {
  name    = "${local.service_name}-${var.environment}-allow-https"
  network = google_compute_network.private.name
  allow {
    protocol = "tcp"
    ports    = ["443"]
  }
  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["slack-scheduler-vm"]
}

resource "google_compute_firewall" "allow_http" {
  name    = "${local.service_name}-${var.environment}-allow-http"
  network = google_compute_network.private.name
  allow {
    protocol = "tcp"
    ports    = ["80"]
  }
  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["slack-scheduler-vm"]
}

resource "google_compute_firewall" "allow_ssh_iap" {
  name    = "${local.service_name}-${var.environment}-allow-ssh-iap"
  network = google_compute_network.private.name
  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
  source_ranges = ["35.235.240.0/20"]
  target_tags   = ["ssh-iap"]
}

resource "google_compute_firewall" "allow_health_checks" {
  name    = "${local.service_name}-${var.environment}-allow-health-checks"
  network = google_compute_network.private.name
  allow {
    protocol = "tcp"
    ports    = ["3000"]
  }
  source_ranges = ["35.191.0.0/16", "130.211.0.0/22"]
  target_tags   = ["slack-scheduler-vm"]
}

resource "google_compute_instance" "app" {
  name         = "${local.service_name}-${var.environment}"
  machine_type = "e2-micro"
  zone         = "${var.region}-a"

  tags = ["slack-scheduler-vm", "ssh-iap"]

  boot_disk {
    initialize_params {
      image = "ubuntu-os-cloud/ubuntu-2404-lts-amd64"
      size  = 50
      type  = "pd-balanced"
    }
    auto_delete = false
  }

  network_interface {
    subnetwork = google_compute_subnetwork.run.self_link
    access_config {
      nat_ip = google_compute_address.app.address
    }
  }

  service_account {
    email  = google_service_account.runtime.email
    scopes = ["cloud-platform"]
  }

  metadata = {
    enable-oslogin = "TRUE"
    startup-script = templatefile("${path.module}/startup-script.tftpl", {
      container_image           = var.container_image
      cloud_sql_connection_name = google_sql_database_instance.postgres.connection_name
      database_name             = google_sql_database.app.name
      iam_user                  = trimsuffix(google_service_account.runtime.email, ".gserviceaccount.com")
      kms_key_name              = google_kms_crypto_key.oauth_tokens.id
      public_base_url           = var.public_base_url
      public_base_url_domain    = replace(replace(var.public_base_url, "https://", ""), "/", "")
      slack_team_id             = var.slack_team_id
      slack_posting_channel_id  = var.slack_posting_channel_id
      slack_recruitment_user_ids = var.slack_recruitment_user_ids
      slack_admin_user_ids      = var.slack_admin_user_ids
      slack_alert_user_ids      = var.slack_alert_user_ids
      google_client_id          = var.google_client_id
      google_redirect_uri       = var.google_redirect_uri
      google_shared_calendar_id = var.google_shared_calendar_id
      google_auth_slack_user_id = var.google_auth_slack_user_id
      secret_names = {
        SLACK_BOT_TOKEN              = google_secret_manager_secret.app["SLACK_BOT_TOKEN"].secret_id
        SLACK_APP_TOKEN              = google_secret_manager_secret.app["SLACK_APP_TOKEN"].secret_id
        JAZZHR_API_KEY               = google_secret_manager_secret.app["JAZZHR_API_KEY"].secret_id
        GOOGLE_CLIENT_SECRET         = google_secret_manager_secret.app["GOOGLE_CLIENT_SECRET"].secret_id
        RECRUITER_PHONE_EXPORT_TOKEN = google_secret_manager_secret.app["RECRUITER_PHONE_EXPORT_TOKEN"].secret_id
        ROLE_ASSIGNMENT_EXPORT_TOKEN = google_secret_manager_secret.app["ROLE_ASSIGNMENT_EXPORT_TOKEN"].secret_id
      }
    })
  }

  deletion_protection = var.environment == "production"

  depends_on = [
    google_project_service.apis,
    google_sql_user.runtime,
    google_secret_manager_secret_iam_member.runtime_secret_access,
  ]
}

resource "google_cloud_run_v2_job" "migrate" {
  name     = "${local.service_name}-migrate"
  location = var.region

  template {
    template {
      service_account = google_service_account.migration.email
      timeout         = "1800s"
      max_retries     = 0

      vpc_access {
        network_interfaces {
          network    = google_compute_network.private.name
          subnetwork = google_compute_subnetwork.run.name
        }
        egress = "PRIVATE_RANGES_ONLY"
      }

      containers {
        image   = var.container_image
        command = ["npm", "run", "migrate"]
        dynamic "env" {
          for_each = merge(local.common_env, {
            CLOUD_SQL_IAM_USER         = trimsuffix(google_service_account.migration.email, ".gserviceaccount.com")
            RUNTIME_CLOUD_SQL_IAM_USER = trimsuffix(google_service_account.runtime.email, ".gserviceaccount.com")
          })
          content {
            name  = env.key
            value = env.value
          }
        }
      }
    }
  }
}

resource "google_cloud_run_v2_job" "retention" {
  name     = "${local.service_name}-retention"
  location = var.region

  template {
    template {
      service_account = google_service_account.runtime.email
      timeout         = "900s"
      max_retries     = 1
      vpc_access {
        network_interfaces {
          network    = google_compute_network.private.name
          subnetwork = google_compute_subnetwork.run.name
        }
        egress = "PRIVATE_RANGES_ONLY"
      }
      containers {
        image   = var.container_image
        command = ["npm", "run", "retention"]
        dynamic "env" {
          for_each = local.common_env
          content {
            name  = env.key
            value = env.value
          }
        }
      }
    }
  }
}

resource "google_project_iam_member" "scheduler_run_jobs" {
  project = var.project_id
  role    = "roles/run.invoker"
  member  = "serviceAccount:${google_service_account.scheduler.email}"
}

resource "google_cloud_scheduler_job" "retention" {
  name      = "${local.service_name}-retention"
  region    = var.region
  schedule  = "15 3 * * *"
  time_zone = "Australia/Sydney"

  http_target {
    http_method = "POST"
    uri         = "https://run.googleapis.com/v2/projects/${var.project_id}/locations/${var.region}/jobs/${google_cloud_run_v2_job.retention.name}:run"
    oauth_token {
      service_account_email = google_service_account.scheduler.email
    }
  }
}

resource "google_monitoring_uptime_check_config" "health" {
  display_name = "${local.service_name}-${var.environment}-health"
  timeout      = "10s"
  period       = "60s"

  http_check {
    path         = "/health"
    port         = 443
    use_ssl      = true
    validate_ssl = true
  }

  monitored_resource {
    type = "uptime_url"
    labels = {
      host       = replace(var.public_base_url, "https://", "")
      project_id = var.project_id
    }
  }
}

resource "google_logging_project_bucket_config" "default" {
  project        = var.project_id
  location       = "global"
  retention_days = 90
  bucket_id      = "_Default"
}

resource "google_monitoring_notification_channel" "email" {
  count        = var.monitoring_email == "" ? 0 : 1
  display_name = "${local.service_name}-${var.environment}-email"
  type         = "email"
  labels = {
    email_address = var.monitoring_email
  }
}

resource "google_logging_metric" "application_errors" {
  name   = "${local.service_name}_${var.environment}_errors"
  filter = "resource.type=\"gce_instance\" AND jsonPayload.severity>=ERROR"
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }
}

resource "google_monitoring_alert_policy" "application_errors" {
  display_name = "${local.service_name}-${var.environment}-application-errors"
  combiner     = "OR"
  conditions {
    display_name = "Application errors"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.application_errors.name}\" AND resource.type=\"gce_instance\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_RATE"
      }
    }
  }
  notification_channels = google_monitoring_notification_channel.email[*].name
}

resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "github-actions"
  display_name              = "GitHub Actions"
}

resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  display_name                       = "GitHub"
  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
  }
  attribute_condition = "assertion.repository == '${var.github_repository}'"
  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
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
  for_each = toset([
    "roles/artifactregistry.writer",
    "roles/cloudkms.admin",
    "roles/cloudsql.admin",
    "roles/compute.instanceAdmin.v1",
    "roles/compute.networkAdmin",
    "roles/iam.serviceAccountAdmin",
    "roles/iam.serviceAccountUser",
    "roles/iap.tunnelResourceAccessor",
    "roles/resourcemanager.projectIamAdmin",
    "roles/run.admin",
    "roles/secretmanager.admin",
    "roles/serviceusage.serviceUsageAdmin",
  ])
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.deploy.email}"
}
