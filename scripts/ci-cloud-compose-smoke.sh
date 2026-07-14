#!/usr/bin/env bash
set -euo pipefail

compose_file="${1:-docker-compose.cloud.split.yml}"
project_suffix="${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}-${RANDOM}"
project_name="open-cowork-cloud-smoke-${project_suffix}"
ready_file="${TMPDIR:-/tmp}/open-cowork-cloud-readyz-${project_suffix}.json"
live_file="${TMPDIR:-/tmp}/open-cowork-cloud-livez-${project_suffix}.json"
gateway_health_file="${TMPDIR:-/tmp}/open-cowork-gateway-ready-${project_suffix}.json"
gateway_smoke_url="${OPEN_COWORK_GATEWAY_SMOKE_URL:-}"

cleanup() {
  docker compose -p "${project_name}" -f "${compose_file}" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -f "${ready_file}" "${live_file}" "${gateway_health_file}"
}

print_diagnostics() {
  docker compose -p "${project_name}" -f "${compose_file}" ps || true
  docker compose -p "${project_name}" -f "${compose_file}" logs --no-color --tail=200 || true
}

trap cleanup EXIT

if ! docker compose -p "${project_name}" -f "${compose_file}" up --build -d; then
  print_diagnostics
  exit 1
fi

cloud_ready=false
for _ in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:8787/readyz" >"${ready_file}"; then
    cat "${ready_file}"
    if ! curl -fsS "http://127.0.0.1:8787/livez" >"${live_file}"; then
      print_diagnostics
      exit 1
    fi
    cat "${live_file}"
    if [ -z "${gateway_smoke_url}" ]; then
      if ! OPEN_COWORK_SMOKE_CLOUD_URL="http://127.0.0.1:8787" \
        OPEN_COWORK_SMOKE_SKIP_GATEWAY=true \
        pnpm deploy:smoke; then
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
    if curl -fsS "${gateway_smoke_url}" >"${gateway_health_file}"; then
      cat "${gateway_health_file}"
      if ! OPEN_COWORK_SMOKE_CLOUD_URL="http://127.0.0.1:8787" \
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
