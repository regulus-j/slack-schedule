variable "project_id" {
  type = string
}

variable "environment" {
  type = string
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production"
  }
}

variable "region" {
  type    = string
  default = "us-central1"
}

variable "container_image" {
  type = string
}

variable "app_machine_type" {
  type    = string
  default = "e2-small"
}
variable "db_machine_type" {
  type    = string
  default = "e2-micro"
}
variable "db_disk_gb" {
  type    = number
  default = 30
}
variable "database_name" {
  type    = string
  default = "scheduler"
}
variable "database_user" {
  type    = string
  default = "scheduler"
}
variable "backup_retention_days" {
  type    = number
  default = 30
}

variable "github_repository" {
  type = string
}

variable "public_base_url" {
  type    = string
  default = ""
}

variable "slack_team_id" {
  type    = string
  default = ""
}

variable "slack_posting_channel_id" {
  type    = string
  default = ""
}

variable "slack_recruitment_user_ids" {
  type    = string
  default = ""
}

variable "slack_admin_user_ids" {
  type    = string
  default = ""
}

variable "slack_alert_user_ids" {
  type    = string
  default = ""
}

variable "google_client_id" {
  type    = string
  default = ""
}

variable "google_redirect_uri" {
  type    = string
  default = ""
}

variable "google_shared_calendar_id" {
  type    = string
  default = ""
}

variable "google_auth_slack_user_id" {
  type    = string
  default = ""
}

variable "recruiter_phone_export_url" {
  type    = string
  default = ""
}

variable "recruiter_phone_export_file_id" {
  type    = string
  default = ""
}

variable "recruiter_phone_export_sheet_name" {
  type    = string
  default = ""
}

variable "role_assignment_export_url" {
  type    = string
  default = ""
}

variable "role_assignment_export_file_id" {
  type    = string
  default = ""
}

variable "role_assignment_export_sheet_name" {
  type    = string
  default = ""
}

variable "role_assignment_export_sheet_gid" {
  type    = string
  default = ""
}

variable "monitoring_email" {
  type    = string
  default = ""
}

variable "billing_account_id" {
  type        = string
  description = "Billing account ID for the optional project budget"
  default     = ""
}

variable "budget_amount" {
  type        = number
  description = "Monthly budget amount in the billing account currency; zero disables budget creation"
  default     = 0
  validation {
    condition     = var.budget_amount >= 0 && floor(var.budget_amount) == var.budget_amount
    error_message = "budget_amount must be a non-negative whole number"
  }
}

variable "budget_currency_code" {
  type        = string
  description = "ISO 4217 currency code for the billing account budget"
  default     = "AUD"
}

variable "secret_next_rotation_time" {
  type        = string
  description = "RFC3339 timestamp used to start the recurring 90-day secret rotation schedule"
  default     = ""
}

variable "secret_names" {
  type = map(string)
  default = {
    DATABASE_URL                 = "database-url"
    DATABASE_PASSWORD            = "database-password"
    SLACK_BOT_TOKEN              = "slack-bot-token"
    SLACK_APP_TOKEN              = "slack-app-token"
    JAZZHR_API_KEY               = "jazzhr-api-key"
    GOOGLE_CLIENT_SECRET         = "google-client-secret"
    RECRUITER_PHONE_EXPORT_TOKEN = "recruiter-phone-export-token"
    ROLE_ASSIGNMENT_EXPORT_TOKEN = "role-assignment-export-token"
  }
}
