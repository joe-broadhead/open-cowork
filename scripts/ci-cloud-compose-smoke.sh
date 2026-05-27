#!/usr/bin/env bash
set -euo pipefail

compose_file="${1:-docker-compose.cloud.split.yml}"
project_suffix="${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}-${RANDOM}"
project_name="open-cowork-cloud-smoke-${project_suffix}"
health_file="${TMPDIR:-/tmp}/open-cowork-cloud-healthz-${project_suffix}.json"

cleanup() {
  docker compose -p "${project_name}" -f "${compose_file}" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -f "${health_file}"
}

trap cleanup EXIT

docker compose -p "${project_name}" -f "${compose_file}" up --build -d

for _ in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:8787/healthz" >"${health_file}"; then
    cat "${health_file}"
    exit 0
  fi
  sleep 2
done

docker compose -p "${project_name}" -f "${compose_file}" ps
docker compose -p "${project_name}" -f "${compose_file}" logs --no-color --tail=200
echo "open-cowork-cloud compose smoke test did not reach /healthz" >&2
exit 1
