#!/usr/bin/env bash
set -euo pipefail
if [[ $# -lt 1 || $# -gt 2 ]]; then
  printf 'Usage: bash deploy/schedule-worker.sh <project-id> [interval-in-minutes]\n' >&2
  exit 2
fi
project=$1
interval=${2:-1}
case "$interval" in 1|2|5|10) ;; *) printf 'Use an interval of 1, 2, 5 or 10 minutes.\n' >&2; exit 2 ;; esac
region=asia-northeast1
worker=night-pro-line-worker
schedule=night-pro-line-notices
account="night-schedule-invoker@$project.iam.gserviceaccount.com"
uri="https://run.googleapis.com/v2/projects/$project/locations/$region/jobs/$worker:run"
# Reuse the dedicated job invoker. Do not grant project-wide execution rights.
gcloud run jobs describe "$worker" --project "$project" --region "$region" >/dev/null
gcloud iam service-accounts describe "$account" --project "$project" >/dev/null
gcloud services enable cloudscheduler.googleapis.com --project "$project" --quiet
gcloud run jobs add-iam-policy-binding "$worker" --project "$project" --region "$region" \
  --member "serviceAccount:$account" --role roles/run.invoker --quiet >/dev/null
existing=$(gcloud scheduler jobs list --project "$project" --location "$region" \
  --filter="name:/$schedule" --format='value(name)')
operation=create
if [[ -n "$existing" ]]; then operation=update; fi
gcloud scheduler jobs "$operation" http "$schedule" --project "$project" --location "$region" \
  --schedule="*/$interval * * * *" --time-zone=Asia/Tokyo --uri="$uri" --http-method=POST \
  --oauth-service-account-email="$account" --oauth-token-scope=https://www.googleapis.com/auth/cloud-platform \
  --headers=Content-Type=application/json --message-body='{}' --attempt-deadline=30s \
  --max-retry-attempts=0 --quiet
# Scheduling never enables a store or overrides the application's send gates.
gcloud scheduler jobs describe "$schedule" --project "$project" --location "$region" \
  --format='table(name.basename(),state,schedule,timeZone,httpTarget.uri)'
