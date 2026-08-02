#!/usr/bin/env bash
set -euo pipefail

compose_file="${1:-docker-compose.cloud.split.yml}"
project_suffix="${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}-${RANDOM}"
project_name="open-cowork-cloud-smoke-${project_suffix}"
ready_file="${TMPDIR:-/tmp}/open-cowork-cloud-readyz-${project_suffix}.json"
live_file="${TMPDIR:-/tmp}/open-cowork-cloud-livez-${project_suffix}.json"
gateway_health_file="${TMPDIR:-/tmp}/open-cowork-gateway-ready-${project_suffix}.json"
gateway_smoke_url="${OPEN_COWORK_GATEWAY_SMOKE_URL:-}"
cloud_smoke_url_input="${OPEN_COWORK_CLOUD_SMOKE_URL:-http://127.0.0.1:${OPEN_COWORK_CLOUD_PUBLISHED_PORT:-8787}}"
cloud_smoke_url="${cloud_smoke_url_input%/}"
curl_connect_timeout_seconds="${OPEN_COWORK_SMOKE_CONNECT_TIMEOUT_SECONDS:-3}"
curl_max_time_seconds="${OPEN_COWORK_SMOKE_MAX_TIME_SECONDS:-10}"
curl_args=(
  --fail
  --silent
  --show-error
  --connect-timeout "${curl_connect_timeout_seconds}"
  --max-time "${curl_max_time_seconds}"
)

cleanup() {
  docker compose -p "${project_name}" -f "${compose_file}" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -f "${ready_file}" "${live_file}" "${gateway_health_file}"
}

print_diagnostics() {
  docker compose -p "${project_name}" -f "${compose_file}" ps || true
  docker compose -p "${project_name}" -f "${compose_file}" logs --no-color --tail=200 || true
}

run_split_role_isolation_proof() {
  if [ "${compose_file}" != "docker-compose.cloud.split.yml" ]; then
    return 0
  fi
  # Prove the exact platform image Compose started for the execution worker.
  # A tag can inspect to an OCI-index digest when the containerd image store is
  # enabled, which is not the image id Docker records on a running boundary.
  local worker_container_id
  local image_id
  worker_container_id="$(
    docker compose -p "${project_name}" -f "${compose_file}" \
      ps -q open-cowork-cloud-worker
  )"
  if [[ ! "${worker_container_id}" =~ ^[a-f0-9]{12,64}$ ]]; then
    echo "cloud isolation proof could not resolve the started worker container" >&2
    return 1
  fi
  image_id="$(docker inspect --format '{{.Image}}' "${worker_container_id}")"
  if [[ ! "${image_id}" =~ ^sha256:[a-f0-9]{64}$ ]]; then
    echo "cloud isolation proof could not resolve the worker platform image id" >&2
    return 1
  fi
  OPEN_COWORK_CLOUD_ISOLATION_IMAGE="${image_id}" \
    OPEN_COWORK_CLOUD_ISOLATION_IMAGE_SHA256="${image_id}" \
    pnpm proof:cloud:tenant-isolation -- --json
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if ! docker compose -p "${project_name}" -f "${compose_file}" up --build -d; then
  print_diagnostics
  exit 1
fi

cloud_ready=false
for _ in $(seq 1 90); do
  if curl "${curl_args[@]}" "${cloud_smoke_url}/readyz" >"${ready_file}"; then
    cat "${ready_file}"
    if ! curl "${curl_args[@]}" "${cloud_smoke_url}/livez" >"${live_file}"; then
      print_diagnostics
      exit 1
    fi
    cat "${live_file}"
    if [ -z "${gateway_smoke_url}" ]; then
      if ! OPEN_COWORK_SMOKE_CLOUD_URL="${cloud_smoke_url}" \
        OPEN_COWORK_SMOKE_SKIP_GATEWAY=true \
        pnpm deploy:smoke; then
        print_diagnostics
        exit 1
      fi
      if ! run_split_role_isolation_proof; then
        print_diagnostics
        exit 1
      fi
      exit 0
    fi
    cloud_ready=true
    break
  fi
  sleep 2
done

if [ "${cloud_ready}" = true ] && [ -n "${gateway_smoke_url}" ]; then
  for _ in $(seq 1 90); do
    if curl "${curl_args[@]}" "${gateway_smoke_url}" >"${gateway_health_file}"; then
      cat "${gateway_health_file}"
      if ! OPEN_COWORK_SMOKE_CLOUD_URL="${cloud_smoke_url}" \
        OPEN_COWORK_SMOKE_GATEWAY_URL="${gateway_smoke_url%/ready}" \
        pnpm deploy:smoke; then
        print_diagnostics
        exit 1
      fi
      exit 0
    fi
    sleep 2
  done
fi

print_diagnostics
if [ "${cloud_ready}" = true ] && [ -n "${gateway_smoke_url}" ]; then
  echo "open-cowork cloud+gateway compose smoke test did not reach ${gateway_smoke_url}" >&2
else
  echo "open-cowork-cloud compose smoke test did not reach /readyz and /livez" >&2
fi
exit 1
