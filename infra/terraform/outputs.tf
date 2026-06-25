output "cloud_run_url" {
  value = google_cloud_run_v2_service.app.uri
}

output "cloud_sql_instance" {
  value = google_sql_database_instance.postgres.connection_name
}

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
