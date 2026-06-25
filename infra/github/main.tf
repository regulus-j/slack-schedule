terraform {
  required_providers {
    github = {
      source  = "integrations/github"
      version = "~> 6.0"
    }
  }
}

variable "repository" {
  type    = string
  default = "slack-schedule"
}

resource "github_branch_protection" "main" {
  repository_id  = var.repository
  pattern        = "main"
  enforce_admins = true

  required_pull_request_reviews {
    dismiss_stale_reviews           = true
    require_code_owner_reviews      = true
    required_approving_review_count = 2
  }

  required_status_checks {
    strict = true
    contexts = [
      "test-and-audit",
      "gitleaks",
      "codeql",
    ]
  }

  restrict_pushes {
    push_allowances = []
  }
}
