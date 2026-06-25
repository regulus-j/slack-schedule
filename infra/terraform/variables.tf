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
  default = "australia-southeast1"
}

variable "container_image" {
  type = string
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

variable "monitoring_email" {
  type    = string
  default = ""
}

variable "secret_next_rotation_time" {
  type        = string
  description = "RFC3339 timestamp used to start the recurring 90-day secret rotation schedule"
  default     = ""
}

variable "secret_names" {
  type = map(string)
  default = {
    SLACK_BOT_TOKEN              = "slack-bot-token"
    SLACK_APP_TOKEN              = "slack-app-token"
    JAZZHR_API_KEY               = "jazzhr-api-key"
    GOOGLE_CLIENT_SECRET         = "google-client-secret"
    RECRUITER_PHONE_EXPORT_TOKEN = "recruiter-phone-export-token"
    ROLE_ASSIGNMENT_EXPORT_TOKEN = "role-assignment-export-token"
  }
}
