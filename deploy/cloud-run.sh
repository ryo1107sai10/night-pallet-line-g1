#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  printf 'Usage: bash deploy/cloud-run.sh <project-id> <cloud-sql-instance|external-postgres> <local-image>\n' >&2
  exit 2
fi

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
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
database_secret=night-db-url
database_args=()
if [[ "$instance" == external-postgres ]]; then
  database_secret=night-supabase-app-url
  database_args=(--clear-cloudsql-instances)
else
  database=$(gcloud sql instances describe "$instance" --project "$project" --format='value(connectionName)')
  if [[ "$database" != "$project:$region:$instance" ]]; then
    printf 'The pilot database must be in the same project and Tokyo region.\n' >&2
    exit 1
  fi
  database_args=(--set-cloudsql-instances "$database")
fi

docker image inspect "$local_image" >/dev/null
if [[ "$(docker image inspect "$local_image" --format '{{.Os}}/{{.Architecture}}')" != linux/amd64 ]]; then
  printf 'Build the image for linux/amd64 first.\n' >&2
  exit 1
fi
gcloud services enable --quiet --project "$project" run.googleapis.com \
  artifactregistry.googleapis.com secretmanager.googleapis.com calendar-json.googleapis.com

if ! gcloud iam service-accounts describe "$account" --project "$project" >/dev/null 2>&1; then
  gcloud iam service-accounts create night-runtime --project "$project" --display-name='Night PRO LINE runtime identity'
fi
if [[ "$instance" != external-postgres ]]; then
  gcloud services enable --quiet --project "$project" sqladmin.googleapis.com
  gcloud projects add-iam-policy-binding "$project" --member "serviceAccount:$account" \
    --role roles/cloudsql.client --condition=None --quiet >/dev/null
fi

secrets=(night-master-key "$database_secret")
bindings="MASTER_KEY=night-master-key:latest,DATABASE_URL=$database_secret:latest"
if [[ "$instance" == external-postgres ]]; then
  secrets+=(night-supabase-ca)
  bindings+=',/secrets/supabase-ca.crt=night-supabase-ca:latest'
fi
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
docker_host=${DOCKER_HOST:-$(docker context inspect "$(docker context show)" --format '{{.Endpoints.docker.Host}}')}
deployment_dir=$(mktemp -d)
docker_config="$deployment_dir/docker"
mkdir "$docker_config"
clear_deployment_files() {
  node -e 'require("node:fs").rmSync(process.argv[1],{recursive:true,force:true})' "$deployment_dir"
}
trap clear_deployment_files EXIT
if [[ -n "$(gcloud run services list --project "$project" --region "$region" --filter="metadata.name=$service" --format='value(metadata.name)')" ]]; then
  gcloud run services describe "$service" --project "$project" --region "$region" --format=json > "$deployment_dir/current.json"
else
  printf '{}\n' > "$deployment_dir/current.json"
fi
node "$script_dir/runtime-config.mjs" prepare "$deployment_dir/current.json" "$deployment_dir" "$origin" "$bindings"
bindings=$(cat "$deployment_dir/bindings")
# Never reattach or redirect an already migrated service accidentally. The
# first database migration must be performed as a separate verified cutover.
case ",$bindings," in
  *,DATABASE_URL="$database_secret":*,*) ;;
  *) printf 'The live database secret does not match the chosen deployment mode. Complete the database cutover first.\n' >&2; exit 1 ;;
esac
gcloud auth print-access-token | docker --config "$docker_config" login "$registry" --username oauth2accesstoken --password-stdin
docker tag "$local_image" "$image"
docker --host "$docker_host" --config "$docker_config" push "$image"

check_tag="verify-$(date -u +%s)"
revision=$(gcloud run deploy "$service" --image "$image" --project "$project" --region "$region" --port 3000 \
  --service-account "$account" "${database_args[@]}" --env-vars-file "$deployment_dir/environment.json" --set-secrets "$bindings" \
  --execution-environment gen2 --cpu 1 --memory 512Mi --concurrency 16 --timeout 45s --min-instances 0 --max-instances 1 \
  --startup-probe 'httpGet.path=/api/health,httpGet.port=3000,periodSeconds=2,failureThreshold=10,timeoutSeconds=2' \
  --no-invoker-iam-check --no-traffic --tag "$check_tag" --quiet --format='value(status.latestReadyRevisionName)')
[[ -n "$revision" ]] || { printf 'No ready revision was returned.\n' >&2; exit 1; }
gcloud run services describe "$service" --project "$project" --region "$region" --format=json > "$deployment_dir/staged.json"
staged_url=$(node "$script_dir/runtime-config.mjs" staged-url "$deployment_dir/staged.json" "$revision" "$check_tag")
curl --fail --silent --show-error --max-time 45 "$staged_url/api/health"
# Resolve the digest so the web service and worker use exactly the same image.
resolved_image=$(gcloud run revisions describe "$revision" --project "$project" --region "$region" --format='value(status.imageDigest)')
[[ "$resolved_image" == *@sha256:* ]] || { printf 'The staged image digest could not be verified.\n' >&2; exit 1; }
gcloud run jobs deploy "$worker" --image "$resolved_image" --project "$project" --region "$region" \
  --service-account "$account" "${database_args[@]}" --env-vars-file "$deployment_dir/environment.json" --set-secrets "$bindings" \
  --command=node --args=dist/worker.js,--once --tasks=1 --max-retries=0 --task-timeout=5m --quiet

gcloud run services update-traffic "$service" --project "$project" --region "$region" \
  --to-revisions "$revision=100" --remove-tags "$check_tag" --quiet
gcloud run services describe "$service" --project "$project" --region "$region" --format=json > "$deployment_dir/live.json"
node "$script_dir/runtime-config.mjs" verify "$deployment_dir/live.json" "$revision"
curl --fail --silent --show-error --max-time 45 "$origin/api/health"
printf '\nVerified revision: %s\n' "$revision"
printf '\nManagement: %s/master/\nGoogle redirect: %s/interview/google-return.html\n' "$origin" "$origin"
