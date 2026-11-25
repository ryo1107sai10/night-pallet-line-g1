#!/usr/bin/env bash
set -euo pipefail
if [[ $# -ne 3 ]]; then
  printf 'Usage: bash deploy/schedule-backup.sh <project> <instance> <published-image>\n' >&2
  exit 2
fi
project=$1
instance=$2
image=$3
region=asia-northeast1
bucket="${project}-db-backups"
account="night-backup-runner@$project.iam.gserviceaccount.com"
invoker="night-schedule-invoker@$project.iam.gserviceaccount.com"
job=night-pro-line-backup
schedule=night-pro-line-daily-backup
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
sql_account=$(gcloud sql instances describe "$instance" --project "$project" --format='value(serviceAccountEmailAddress)')
gcloud storage buckets describe "gs://$bucket" --project "$project" >/dev/null
gcloud storage buckets update "gs://$bucket" --uniform-bucket-level-access --public-access-prevention \
  --lifecycle-file "$script_dir/backup-lifecycle.json" --quiet
gcloud storage buckets add-iam-policy-binding "gs://$bucket" --member "serviceAccount:$sql_account" \
  --role roles/storage.objectCreator --quiet >/dev/null
if ! gcloud iam service-accounts describe "$account" --project "$project" >/dev/null 2>&1; then
  gcloud iam service-accounts create night-backup-runner --project "$project" --display-name 'Night PRO LINE daily backup'
fi
if ! gcloud iam roles describe nightSqlExport --project "$project" >/dev/null 2>&1; then
  gcloud iam roles create nightSqlExport --project "$project" --title 'Night PRO LINE SQL export' \
    --permissions cloudsql.instances.get,cloudsql.instances.export --stage GA
fi
gcloud projects add-iam-policy-binding "$project" --member "serviceAccount:$account" \
  --role "projects/$project/roles/nightSqlExport" --condition=None --quiet >/dev/null
gcloud run jobs deploy "$job" --project "$project" --region "$region" --image "$image" \
  --service-account "$account" --set-env-vars "BACKUP_PROJECT=$project,BACKUP_INSTANCE=$instance,BACKUP_BUCKET=$bucket,BACKUP_DATABASE=night" \
  --command node --args dist/backup.js --tasks 1 --max-retries 1 --task-timeout 14m --quiet
gcloud run jobs add-iam-policy-binding "$job" --project "$project" --region "$region" \
  --member "serviceAccount:$invoker" --role roles/run.invoker --quiet >/dev/null
gcloud services enable cloudscheduler.googleapis.com --project "$project" --quiet
uri="https://run.googleapis.com/v2/projects/$project/locations/$region/jobs/$job:run"
if gcloud scheduler jobs describe "$schedule" --project "$project" --location "$region" >/dev/null 2>&1; then
  operation=update; headers_flag=--update-headers=Content-Type=application/json
else
  operation=create; headers_flag=--headers=Content-Type=application/json
fi
gcloud scheduler jobs "$operation" http "$schedule" --project "$project" --location "$region" \
  --schedule='0 9 * * *' --time-zone=Asia/Tokyo --uri="$uri" --http-method=POST \
  --oauth-service-account-email="$invoker" --oauth-token-scope=https://www.googleapis.com/auth/cloud-platform \
  "$headers_flag" --message-body='{}' --attempt-deadline=30s --max-retry-attempts=0 --quiet
