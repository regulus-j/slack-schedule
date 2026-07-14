#!/usr/bin/env bash
# Push all GitHub Actions variables and secrets from a single .env.gh file.
#
# Usage:
#   1. cp .env.gh.example .env.gh
#   2. Fill in .env.gh
#   3. bash scripts/set-github-vars.sh
#
# Requires: gh CLI installed and authenticated (gh auth login)

set -euo pipefail

cd "$(cd "$(dirname "$0")" && pwd)/.."
ENV_FILE="${1:-.env.gh}"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE not found."
  echo "  cp .env.gh.example .env.gh"
  echo "  Fill in the values, then re-run."
  exit 1
fi

echo "==> Loading $ENV_FILE"

# Parse .env: strip CR, comments, trailing whitespace, blank lines
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%%$'\r'}"                 # strip Windows CR
  line="${line%%#*}"                    # strip comments
  line="${line%"${line##*[![:space:]]}"}" # strip trailing whitespace
  [ -z "$line" ] && continue
  case "$line" in
    *=*) export "${line%%=*}=${line#*=}" ;;
  esac
done < "$ENV_FILE"

REPO="$(gh repo view --json nameWithOwner -q '.nameWithOwner' 2>/dev/null || echo '')"
if [ -z "$REPO" ]; then
  echo "ERROR: Could not determine repo. Run 'gh auth login' first."
  exit 1
fi
echo "==> Repository: $REPO"
echo ""

# ── Defaults ─────────────────────────────────────────────────────────────
: "${GCP_REGION:=us-central1}"
: "${TERRAFORM_STATE_BUCKET:=slack-scheduler-tfstate}"
if [ -z "${GCP_PROJECT_ID:-}" ]; then
  GCP_PROJECT_ID="$(gcloud config get-value project 2>/dev/null || echo '')"
fi
if [ -z "${GOOGLE_REDIRECT_URI:-}" ]; then
  GOOGLE_REDIRECT_URI="${PUBLIC_BASE_URL:-}/oauth/google/callback"
fi

# ── Terraform outputs ────────────────────────────────────────────────────
if [ -d "infra/terraform" ]; then
  tf_out() { terraform -chdir=infra/terraform output -raw "$1" 2>/dev/null || echo ''; }
  WIF="$(tf_out workload_identity_provider)"
  SA="$(tf_out deploy_service_account)"
  [ -n "$WIF" ] && : "${GCP_WORKLOAD_IDENTITY_PROVIDER:=$WIF}"
  [ -n "$SA" ] && : "${GCP_DEPLOY_SERVICE_ACCOUNT:=$SA}"
  [ -n "$WIF" ] && echo "   Terraform outputs loaded OK"
fi

# ── Validate ─────────────────────────────────────────────────────────────
missing=""
require() {
  eval "local v=\${$1:-}"
  if [ -z "$v" ]; then
    missing="$missing  $1"$'\n'
  fi
}

require GCP_PROJECT_ID
require GCP_WORKLOAD_IDENTITY_PROVIDER
require GCP_DEPLOY_SERVICE_ACCOUNT
require TERRAFORM_STATE_BUCKET
require PUBLIC_BASE_URL
require GOOGLE_REDIRECT_URI
require SLACK_TEAM_ID
require SLACK_POSTING_CHANNEL_ID
require SLACK_RECRUITMENT_USER_IDS
require SLACK_ADMIN_USER_IDS
require SLACK_ALERT_USER_IDS
require GOOGLE_AUTH_SLACK_USER_ID
require GOOGLE_CLIENT_ID
require GOOGLE_SHARED_CALENDAR_ID
require MONITORING_EMAIL

if [ -n "$missing" ]; then
  echo "ERROR: missing required values:"
  echo "$missing"
  echo "Add them to $ENV_FILE and re-run."
  exit 1
fi

# ── Push variables ───────────────────────────────────────────────────────
echo ""
echo "==> Setting variables..."

v() { gh variable set "$1" -b "${!1}" -R "$REPO"; }

v GCP_PROJECT_ID
v GCP_REGION
v GCP_WORKLOAD_IDENTITY_PROVIDER
v GCP_DEPLOY_SERVICE_ACCOUNT
v TERRAFORM_STATE_BUCKET
v PUBLIC_BASE_URL
v GOOGLE_REDIRECT_URI
v SLACK_TEAM_ID
v SLACK_POSTING_CHANNEL_ID
v SLACK_RECRUITMENT_USER_IDS
v SLACK_ADMIN_USER_IDS
v SLACK_ALERT_USER_IDS
v GOOGLE_CLIENT_ID
v GOOGLE_SHARED_CALENDAR_ID
v GOOGLE_AUTH_SLACK_USER_ID
v MONITORING_EMAIL
gh variable set SECRET_NEXT_ROTATION_TIME -b "" -R "$REPO"

echo "   Variables done."

# ── Push secrets (only if present in .env.gh) ────────────────────────────
for name in SLACK_BOT_TOKEN SLACK_APP_TOKEN JAZZHR_API_KEY GOOGLE_CLIENT_SECRET; do
  eval "local val=\${$name:-}"
  if [ -n "${val:-}" ]; then
    gh secret set "$name" -b "$val" -R "$REPO"
    echo "   $name (secret) ✓"
  fi
done

echo ""
echo "==> All done."
