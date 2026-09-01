output "cloud_run_service" { value = "disabled-single-vm" }

output "application_instance" {
  value = google_compute_instance.app.name
}

output "database_private_ip" { value = "127.0.0.1" }

output "artifact_repository" {
  value = google_artifact_registry_repository.app.name
}

output "workload_identity_provider" {
  value = google_iam_workload_identity_pool_provider.github.name
}

output "deploy_service_account" {
  value = google_service_account.deploy.email
}

output "secret_ids" {
  value = { for key, secret in google_secret_manager_secret.app : key => secret.secret_id }
}
