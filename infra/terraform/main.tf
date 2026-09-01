locals {
  service_name                = "slack-scheduler"
  runtime_config_secret_names = var.environment == "production" ? toset(["JAZZHR_ACCOUNT_KEYS", "JAZZHR_API_KEY_FPI", "JAZZHR_API_KEY_OPG", "JAZZHR_COMPANY_NAME_FPI", "JAZZHR_COMPANY_NAME_OPG", "RECRUITER_PHONE_EXPORT_URL", "RECRUITER_PHONE_EXPORT_FILE_ID", "ROLE_ASSIGNMENT_EXPORT_URL", "ROLE_ASSIGNMENT_EXPORT_FILE_ID", "ROLE_ASSIGNMENT_EXPORT_SHEET_GID"]) : toset([])
}

data "google_project" "current" { project_id = var.project_id }
data "google_secret_manager_secret" "runtime_config" {
  for_each  = local.runtime_config_secret_names
  project   = var.project_id
  secret_id = each.value
}
resource "google_project_service" "apis" {
  for_each           = toset(["artifactregistry.googleapis.com", "compute.googleapis.com", "iamcredentials.googleapis.com", "iap.googleapis.com", "logging.googleapis.com", "monitoring.googleapis.com", "secretmanager.googleapis.com", "storage.googleapis.com", "serviceusage.googleapis.com"])
  service            = each.value
  disable_on_destroy = false
}
resource "google_billing_budget" "project" {
  count           = var.billing_account_id != "" && var.budget_amount > 0 ? 1 : 0
  billing_account = var.billing_account_id
  display_name    = "${local.service_name}-${var.environment}-monthly"
  budget_filter { projects = ["projects/${data.google_project.current.number}"] }
  amount {
    specified_amount {
      currency_code = var.budget_currency_code
      units         = tostring(var.budget_amount)
    }
  }
  threshold_rules { threshold_percent = 0.5 }
  threshold_rules { threshold_percent = 0.9 }
  threshold_rules { threshold_percent = 1.0 }
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
  name                     = "${local.service_name}-app"
  region                   = var.region
  network                  = google_compute_network.private.id
  ip_cidr_range            = "10.20.0.0/24"
  private_ip_google_access = true
}
resource "google_service_account" "app" {
  account_id   = "scheduler-runtime"
  display_name = "Slack Scheduler runtime"
}
resource "google_storage_bucket" "backups" {
  name                        = "${var.project_id}-${local.service_name}-postgres-backups"
  location                    = var.region
  uniform_bucket_level_access = true
  force_destroy               = false
  lifecycle_rule {
    condition { age = var.backup_retention_days }
    action { type = "Delete" }
  }
}
resource "google_storage_bucket_iam_member" "backup_writer" {
  bucket = google_storage_bucket.backups.name
  role   = "roles/storage.objectCreator"
  member = "serviceAccount:${google_service_account.app.email}"
}
resource "google_secret_manager_secret" "app" {
  for_each  = var.secret_names
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
resource "google_secret_manager_secret_iam_member" "runtime_config_access" {
  for_each  = data.google_secret_manager_secret.runtime_config
  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.app.email}"
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
resource "google_compute_firewall" "iap_ssh" {
  name    = "${local.service_name}-${var.environment}-iap-ssh"
  network = google_compute_network.private.name
  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
  source_ranges = ["35.235.240.0/20"]
  target_tags   = ["slack-scheduler-app"]
}
resource "google_compute_firewall" "web" {
  name    = "${local.service_name}-${var.environment}-web"
  network = google_compute_network.private.name
  allow {
    protocol = "tcp"
    ports    = ["80", "443"]
  }
  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["slack-scheduler-app"]
}
resource "google_project_iam_member" "app_artifact_reader" {
  project = var.project_id
  role    = "roles/artifactregistry.reader"
  member  = "serviceAccount:${google_service_account.app.email}"
}
resource "google_compute_instance" "app" {
  name         = "${local.service_name}-${var.environment}-app"
  machine_type = "e2-micro"
  zone         = "${var.region}-a"
  tags         = ["slack-scheduler-app"]
  boot_disk {
    initialize_params {
      image = "ubuntu-os-cloud/ubuntu-2404-lts-amd64"
      size  = 10
      type  = "pd-standard"
    }
  }
  network_interface {
    subnetwork = google_compute_subnetwork.app.id
    access_config {}
  }
  service_account {
    email  = google_service_account.app.email
    scopes = ["cloud-platform"]
  }
  metadata = { startup-script = templatefile("${path.module}/single-vm-startup-script.tftpl", {
    container_image             = var.container_image
    container_registry          = "${var.region}-docker.pkg.dev"
    database_name               = var.database_name
    database_user               = var.database_user
    database_password_secret    = google_secret_manager_secret.app["DATABASE_PASSWORD"].secret_id
    backup_bucket               = google_storage_bucket.backups.name
    kms_key_name                = google_kms_crypto_key.oauth_tokens.id
    public_base_url             = trim(var.public_base_url, "/")
    public_base_url_domain      = trim(replace(replace(trim(var.public_base_url, "/"), "https://", ""), "http://", ""), "/")
    secret_names                = { for key, secret in google_secret_manager_secret.app : key => secret.secret_id }
    runtime_config_secret_names = local.runtime_config_secret_names
    slack_team_id               = var.slack_team_id
    slack_posting_channel_id    = var.slack_posting_channel_id
    slack_recruitment_user_ids  = var.slack_recruitment_user_ids
    slack_admin_user_ids        = var.slack_admin_user_ids
    slack_alert_user_ids        = var.slack_alert_user_ids
    google_client_id            = var.google_client_id
    google_redirect_uri         = var.google_redirect_uri
    google_shared_calendar_id   = var.google_shared_calendar_id
    google_auth_slack_user_id   = var.google_auth_slack_user_id
  }) }
  depends_on = [google_project_iam_member.app_artifact_reader]
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
  for_each = toset(["roles/artifactregistry.writer", "roles/compute.instanceAdmin.v1", "roles/compute.networkAdmin", "roles/compute.osAdminLogin", "roles/compute.securityAdmin", "roles/iap.tunnelResourceAccessor", "roles/iam.serviceAccountUser", "roles/iam.workloadIdentityPoolAdmin", "roles/cloudkms.admin", "roles/logging.viewer", "roles/resourcemanager.projectIamAdmin", "roles/secretmanager.admin", "roles/serviceusage.serviceUsageAdmin", "roles/storage.admin"])
  project  = var.project_id
  role     = each.value
  member   = "serviceAccount:${google_service_account.deploy.email}"
}
