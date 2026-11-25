#!/usr/bin/env bash
set -euo pipefail
if [[ $# -ne 1 ]]; then
  printf 'Usage: bash deploy/schedule-http-worker.sh <project-id>\n' >&2
  exit 2
fi
project=$1
region=asia-northeast1
service=night-pro-line
schedule=night-pro-line-notices
account="night-schedule-invoker@$project.iam.gserviceaccount.com"
number=$(gcloud projects describe "$project" --format='value(projectNumber)')
[[ "$number" =~ ^[0-9]+$ ]]
uri="https://$service-$number.$region.run.app/internal/scheduled-work"
gcloud iam service-accounts describe "$account" --project "$project" >/dev/null
configured=$(gcloud run services describe "$service" --project "$project" --region "$region" \
  --format=json | node -e 'let data="";process.stdin.on("data",chunk=>data+=chunk).on("end",()=>{const s=JSON.parse(data);const env=s.spec.template.spec.containers[0].env;const current=env.find(e=>e.name==="SCHEDULE_WORKER_ACCOUNT");process.stdout.write(current?.value??"")})')
[[ "$configured" == "$account" ]] || { printf 'Deploy the authenticated scheduled worker before changing its trigger.\n' >&2; exit 1; }
existing=$(gcloud scheduler jobs list --project "$project" --location "$region" \
  --filter="name:/$schedule" --format='value(name)')
operation=create
if [[ -n "$existing" ]]; then operation=update; fi
# Request-based Cloud Run billing replaces the one-minute minimum per Job.
# Keep the exact same one-minute cadence and retry failures without invoking a second job.
gcloud scheduler jobs "$operation" http "$schedule" --project "$project" --location "$region" \
  --schedule='* * * * *' --time-zone=Asia/Tokyo --uri="$uri" --http-method=POST \
  --oidc-service-account-email="$account" --oidc-token-audience="$uri" \
  --attempt-deadline=45s --max-retry-attempts=2 --min-backoff=5s --max-backoff=10s --max-retry-duration=45s --quiet
gcloud scheduler jobs describe "$schedule" --project "$project" --location "$region" \
  --format='table(name.basename(),state,schedule,timeZone,httpTarget.uri)'
