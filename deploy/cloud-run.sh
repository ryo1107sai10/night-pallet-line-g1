#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  printf 'Usage: bash deploy/cloud-run.sh <project-id> <cloud-sql-instance> <local-image>\n' >&2
  exit 2
fi

project=$1
instance=$2
local_image=$3
region=asia-northeast1
service=night-pro-line
worker=night-pro-line-worker
repository=night-pro-line
account="night-runtime@$project.iam.gserviceaccount.com"
registry="$region-docker.pkg.dev"

if [[ "$(gcloud billing projects describe "$project" --format='value(billingEnabled)')" != True ]]; then
  printf 'Link the selected billing account to the pilot project first.\n' >&2
  exit 1
fi

project_number=$(gcloud projects describe "$project" --format='value(projectNumber)')
origin="https://$service-$project_number.$region.run.app"
database=$(gcloud sql instances describe "$instance" --project "$project" --format='value(connectionName)')
if [[ "$database" != "$project:$region:$instance" ]]; then
  printf 'The pilot database must be in the same project and Tokyo region.\n' >&2
  exit 1
fi

docker image inspect "$local_image" >/dev/null
if [[ "$(docker image inspect "$local_image" --format '{{.Os}}/{{.Architecture}}')" != linux/amd64 ]]; then
  printf 'Build the image for linux/amd64 first.\n' >&2
  exit 1
fi
gcloud services enable --quiet --project "$project" run.googleapis.com sqladmin.googleapis.com \
  artifactregistry.googleapis.com secretmanager.googleapis.com calendar-json.googleapis.com

if ! gcloud iam service-accounts describe "$account" --project "$project" >/dev/null 2>&1; then
  gcloud iam service-accounts create night-runtime --project "$project" --display-name='Night PRO LINE runtime identity'
fi
gcloud projects add-iam-policy-binding "$project" --member "serviceAccount:$account" \
  --role roles/cloudsql.client --condition=None --quiet >/dev/null

secrets=(night-master-key night-db-url)
bindings='MASTER_KEY=night-master-key:latest,DATABASE_URL=night-db-url:latest'
google_id=false
google_secret=false
if gcloud secrets describe night-google-client-id --project "$project" >/dev/null 2>&1; then google_id=true; fi
if gcloud secrets describe night-google-client-secret --project "$project" >/dev/null 2>&1; then google_secret=true; fi
if [[ "$google_id" != "$google_secret" ]]; then
  printf 'Configure both Google OAuth secrets together.\n' >&2
  exit 1
fi
if [[ "$google_id" == true ]]; then
  secrets+=(night-google-client-id night-google-client-secret)
  bindings+=',GOOGLE_CALENDAR_CLIENT_ID=night-google-client-id:latest,GOOGLE_CALENDAR_CLIENT_SECRET=night-google-client-secret:latest'
fi
for secret in "${secrets[@]}"; do
  gcloud secrets describe "$secret" --project "$project" >/dev/null
  gcloud secrets add-iam-policy-binding "$secret" --project "$project" --member "serviceAccount:$account" \
    --role roles/secretmanager.secretAccessor --condition=None --quiet >/dev/null
done

if ! gcloud artifacts repositories describe "$repository" --project "$project" --location "$region" >/dev/null 2>&1; then
  gcloud artifacts repositories create "$repository" --project "$project" --location "$region" \
    --repository-format=docker --description='Night PRO LINE pilot images'
fi

image_id=$(docker image inspect "$local_image" --format '{{.Id}}')
image="$registry/$project/$repository/app:${image_id#sha256:}"
docker_config=$(mktemp -d)
clear_docker_credentials() {
  if [[ -f "$docker_config/config.json" ]]; then unlink "$docker_config/config.json"; fi
  rmdir "$docker_config"
}
trap clear_docker_credentials EXIT
gcloud auth print-access-token | docker --config "$docker_config" login "$registry" --username oauth2accesstoken --password-stdin
docker tag "$local_image" "$image"
docker --config "$docker_config" push "$image"

environment="PUBLIC_ORIGIN=$origin,AUTO_SEND_ENABLED=false"
gcloud run deploy "$service" --image "$image" --project "$project" --region "$region" --port 3000 \
  --service-account "$account" --set-cloudsql-instances "$database" --set-env-vars "$environment" --set-secrets "$bindings" \
  --execution-environment gen2 --cpu 1 --memory 512Mi --concurrency 16 --timeout 45s --min-instances 0 --max-instances 1 \
  --startup-probe 'httpGet.path=/healthz,httpGet.port=3000,periodSeconds=2,failureThreshold=10,timeoutSeconds=2' \
  --no-invoker-iam-check --quiet
gcloud run jobs deploy "$worker" --image "$image" --project "$project" --region "$region" \
  --service-account "$account" --set-cloudsql-instances "$database" --set-env-vars "$environment" --set-secrets "$bindings" \
  --command=node --args=dist/worker.js,--once --tasks=1 --max-retries=0 --task-timeout=5m --quiet

deployed=$(gcloud run services describe "$service" --project "$project" --region "$region" --format='value(status.url)')
if [[ "$deployed" != "$origin" ]]; then
  printf 'Cloud Run returned an unexpected URL. Verify PUBLIC_ORIGIN.\n' >&2
  exit 1
fi
curl --fail --silent --show-error --max-time 45 "$origin/healthz"
printf '\nManagement: %s/\nGoogle redirect: %s/interview/google-return.html\n' "$origin" "$origin"
