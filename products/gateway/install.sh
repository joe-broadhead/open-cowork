#!/usr/bin/env bash
set -Eeuo pipefail

# OpenCode Gateway verified release bootstrap.
#
# Normal installs download install.sh, SHA256SUMS, and the Sigstore bundle from
# one immutable GitHub release. Verify the bundle and install.sh checksum before
# running this file; see docs/getting-started/installation.md.
#
# Options:
#   --yes, --non-interactive   Skip the setup wizard and use safe defaults.
#   --dry-run                  Print what the script would do, then exit.
#   --version <vX.Y.Z>         Install a specific immutable release tag.
#   --unsafe-ref <ref>         Development-only install from a mutable ref or SHA.
#   --allow-unsafe-ref         Required with --unsafe-ref; acknowledges the warning.

REPO="joe-broadhead/opencode-gateway"
REMOTE_URL="https://github.com/${REPO}.git"
DEFAULT_RELEASE_TAG="v1.3.0"
INSTALL_DIR="${OPENCODE_GATEWAY_INSTALL_DIR:-${HOME}/opencode-gateway}"
CONFIG_DIR="${OPENCODE_GATEWAY_CONFIG_DIR:-${HOME}/.config/opencode-gateway}"
CONFIG_FILE="${CONFIG_DIR}/config.json"
STATE_DIR="${OPENCODE_GATEWAY_STATE_DIR:-${CONFIG_DIR}}"
TRANSACTION_TEMPLATE="${INSTALL_DIR}.transaction.XXXXXX"
TRANSACTION_DIR=""
TRANSACTION_MARKER_NAME=".opencode-gateway-installer-transaction"
TRANSACTION_MARKER_VALUE="opencode-gateway-installer-transaction-v1"
STAGING_DIR="${TRANSACTION_TEMPLATE}/staging"
ROLLBACK_DIR="${TRANSACTION_TEMPLATE}/previous"
FAILED_DIR="${TRANSACTION_TEMPLATE}/failed"
CONFIG_ROLLBACK_DIR="${TRANSACTION_TEMPLATE}/config-previous"
STATE_ROLLBACK_DIR="${TRANSACTION_TEMPLATE}/state-previous"
STARTUP_GRACE_SECONDS="${OPENCODE_GATEWAY_INSTALL_STARTUP_GRACE_SECONDS:-60}"
READINESS_POLL_SECONDS=2

EXISTING_INSTALL=0
NON_INTERACTIVE=0
DRY_RUN=0
REQUESTED_TAG="${OPENCODE_GATEWAY_INSTALL_VERSION:-}"
REQUESTED_REF="${OPENCODE_GATEWAY_INSTALL_REF:-}"
UNSAFE_REF=""
ALLOW_UNSAFE_REF=0
INSTALL_REF=""
INSTALL_REF_KIND="tag"
PIPED_STDIN=0
DOWNLOAD_DIR=""
TRANSACTION_ACTIVE=0
HAD_PREVIOUS=0
NEW_ACTIVE=0
GLOBAL_CLI_INSTALL_ATTEMPTED=0
GLOBAL_CLI_PREEXISTED=0
GLOBAL_PACKAGE_DIR=""
GLOBAL_CLI_BIN=""
SERVICE_INSTALL_ATTEMPTED=0
SERVICE_PREEXISTED=0
SERVICE_FILE=""
CONFIG_SNAPSHOT_TAKEN=0
STATE_SNAPSHOT_TAKEN=0

is_release_tag() {
  [[ "$1" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]]
}

is_safe_unsafe_ref() {
  [[ "$1" =~ ^[0-9A-Za-z][0-9A-Za-z._/@+-]*$ ]] &&
    [[ "$1" != *..* ]] &&
    [[ "$1" != *'@{'* ]]
}

print_unsafe_ref_warning() {
  cat >&2 <<EOF
WARNING: unsafe source ref requested: ${UNSAFE_REF}

This development path can install code from a mutable branch or arbitrary ref.
It bypasses the signed release manifest, checksum, protected-main tag binding,
and tagged release evidence path. Use a v* release tag for normal installs.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --yes|--non-interactive) NON_INTERACTIVE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --version)
      shift
      [ "$#" -gt 0 ] || { echo "Error: --version requires a v* release tag"; exit 1; }
      REQUESTED_TAG="$1"
      ;;
    --version=*) REQUESTED_TAG="${1#*=}" ;;
    --unsafe-ref)
      shift
      [ "$#" -gt 0 ] || { echo "Error: --unsafe-ref requires a ref value"; exit 1; }
      UNSAFE_REF="$1"
      ;;
    --unsafe-ref=*) UNSAFE_REF="${1#*=}" ;;
    --allow-unsafe-ref|--i-understand-unsafe-ref) ALLOW_UNSAFE_REF=1 ;;
    *)
      echo "Unknown option: $1 (supported: --yes | --non-interactive | --dry-run | --version <tag> | --unsafe-ref <ref> --allow-unsafe-ref)"
      exit 1
      ;;
  esac
  shift
done

if [ -n "$REQUESTED_REF" ] && [ -z "$REQUESTED_TAG" ] && [ -z "$UNSAFE_REF" ]; then
  if is_release_tag "$REQUESTED_REF"; then
    REQUESTED_TAG="$REQUESTED_REF"
  else
    UNSAFE_REF="$REQUESTED_REF"
  fi
fi

if [ -n "$REQUESTED_TAG" ] && [ -n "$UNSAFE_REF" ]; then
  echo "Error: choose either --version or --unsafe-ref, not both"
  exit 1
fi

if [ -z "$REQUESTED_TAG" ] && [ -z "$UNSAFE_REF" ]; then
  REQUESTED_TAG="$DEFAULT_RELEASE_TAG"
fi

if [ -n "$REQUESTED_TAG" ]; then
  if ! is_release_tag "$REQUESTED_TAG"; then
    echo "Error: --version must be an immutable release tag like v1.2.3"
    exit 1
  fi
  INSTALL_REF="$REQUESTED_TAG"
  INSTALL_REF_KIND="tag"
else
  case "$ALLOW_UNSAFE_REF" in
    1|true|TRUE|yes|YES) ;;
    *)
      print_unsafe_ref_warning
      echo >&2
      echo "Refusing unsafe install. Re-run with --allow-unsafe-ref only for local development." >&2
      exit 1
      ;;
  esac
  if ! is_safe_unsafe_ref "$UNSAFE_REF"; then
    echo "Error: unsafe ref contains unsupported or ambiguous git ref characters" >&2
    exit 1
  fi
  print_unsafe_ref_warning
  INSTALL_REF="$UNSAFE_REF"
  INSTALL_REF_KIND="unsafe"
fi

if [[ ! "$STARTUP_GRACE_SECONDS" =~ ^[0-9]{1,3}$ ]]; then
  echo "Error: OPENCODE_GATEWAY_INSTALL_STARTUP_GRACE_SECONDS must be an integer from 10 through 300" >&2
  exit 1
fi
STARTUP_GRACE_SECONDS="$((10#$STARTUP_GRACE_SECONDS))"
if [ "$STARTUP_GRACE_SECONDS" -lt 10 ] || [ "$STARTUP_GRACE_SECONDS" -gt 300 ]; then
  echo "Error: OPENCODE_GATEWAY_INSTALL_STARTUP_GRACE_SECONDS must be an integer from 10 through 300" >&2
  exit 1
fi

if [ ! -t 0 ] && [ "$NON_INTERACTIVE" -eq 0 ]; then
  NON_INTERACTIVE=1
  PIPED_STDIN=1
fi

echo
echo "  OpenCode Gateway - Durable Work Coordinator"
echo "  ==========================================="
echo

if [ "$NON_INTERACTIVE" -eq 1 ]; then
  if [ "$PIPED_STDIN" -eq 1 ]; then
    echo "  stdin is not a terminal: running non-interactively with safe defaults."
  else
    echo "  Running non-interactively with safe defaults."
  fi
  echo "  Review or change them later with: opencode-gateway setup"
  echo
fi

if [ "$DRY_RUN" -eq 1 ]; then
  echo "  Dry run - no changes will be made. The script would:"
  if [ "$INSTALL_REF_KIND" = "tag" ]; then
    echo "    1. Download ${INSTALL_REF} release assets and verify the signed SHA256SUMS manifest"
    echo "    2. Verify the source archive checksum and exact package version"
  else
    echo "    1. Fetch explicitly acknowledged unsafe ref ${INSTALL_REF} into a staging directory"
    echo "    2. Record that signature/checksum release verification was bypassed"
  fi
  echo "    3. Build and check the release in ${STAGING_DIR} without lifecycle scripts"
  echo "    4. Stop the old service, atomically switch ${INSTALL_DIR}, and install the CLI"
  if [ -d "$INSTALL_DIR" ] && [ -f "$CONFIG_FILE" ]; then
    echo "    5. Reconcile existing config/state with: opencode-gateway update --yes"
  elif [ "$NON_INTERACTIVE" -eq 1 ]; then
    echo "    5. Run first-time setup with defaults: opencode-gateway setup --yes"
  else
    echo "    5. Run the interactive setup wizard: opencode-gateway setup"
  fi
  echo "    6. Require the user service to be loaded, healthy, and strictly ready"
  echo "    7. Restore ${ROLLBACK_DIR} plus config/state snapshots and return nonzero if any post-switch check fails"
  exit 0
fi

cleanup() {
  if [ -n "$DOWNLOAD_DIR" ] && [ -d "$DOWNLOAD_DIR" ]; then
    rm -rf -- "$DOWNLOAD_DIR"
  fi
  if [ -n "$TRANSACTION_DIR" ] && [ -d "$TRANSACTION_DIR" ]; then
    if is_installer_owned_transaction; then
      if [ -d "$STAGING_DIR" ]; then
        rm -rf -- "$STAGING_DIR"
      fi
      if [ ! -e "$STAGING_DIR" ] && [ ! -e "$ROLLBACK_DIR" ] && [ ! -e "$FAILED_DIR" ]; then
        rm -rf -- "$TRANSACTION_DIR"
      fi
    else
      echo "Warning: refusing to clean unvalidated transaction directory ${TRANSACTION_DIR}" >&2
    fi
  fi
}

is_installer_owned_transaction() {
  [ -n "$TRANSACTION_DIR" ] &&
    [ -d "$TRANSACTION_DIR" ] &&
    [ ! -L "$TRANSACTION_DIR" ] &&
    [ -f "${TRANSACTION_DIR}/${TRANSACTION_MARKER_NAME}" ] &&
    [ "$(cat "${TRANSACTION_DIR}/${TRANSACTION_MARKER_NAME}")" = "$TRANSACTION_MARKER_VALUE" ]
}

create_transaction() {
  TRANSACTION_DIR="$(mktemp -d "$TRANSACTION_TEMPLATE")"
  STAGING_DIR="${TRANSACTION_DIR}/staging"
  ROLLBACK_DIR="${TRANSACTION_DIR}/previous"
  FAILED_DIR="${TRANSACTION_DIR}/failed"
  CONFIG_ROLLBACK_DIR="${TRANSACTION_DIR}/config-previous"
  STATE_ROLLBACK_DIR="${TRANSACTION_DIR}/state-previous"
  printf '%s\n' "$TRANSACTION_MARKER_VALUE" > "${TRANSACTION_DIR}/${TRANSACTION_MARKER_NAME}"
  is_installer_owned_transaction || {
    echo "Error: could not validate installer transaction directory ${TRANSACTION_DIR}" >&2
    return 1
  }
}

snapshot_runtime_state() {
  if [ -d "$CONFIG_DIR" ]; then
    mkdir -p "$CONFIG_ROLLBACK_DIR"
    cp -a "${CONFIG_DIR}/." "$CONFIG_ROLLBACK_DIR/"
    CONFIG_SNAPSHOT_TAKEN=1
  fi
  if [ "$STATE_DIR" != "$CONFIG_DIR" ] && [ -d "$STATE_DIR" ]; then
    mkdir -p "$STATE_ROLLBACK_DIR"
    cp -a "${STATE_DIR}/." "$STATE_ROLLBACK_DIR/"
    STATE_SNAPSHOT_TAKEN=1
  fi
}

restore_snapshot_dir() {
  local source_dir="$1"
  local target_dir="$2"
  local label="$3"
  local failed_dir="${target_dir}.failed.$(date +%s)"

  [ -d "$source_dir" ] || return 0
  if [ -e "$target_dir" ] || [ -L "$target_dir" ]; then
    if ! mv "$target_dir" "$failed_dir"; then
      echo "Rollback error: could not move failed ${label} out of ${target_dir}." >&2
      return 1
    fi
  fi
  mkdir -p "$target_dir"
  if ! cp -a "${source_dir}/." "$target_dir/"; then
    echo "Rollback error: could not restore ${label} snapshot to ${target_dir}." >&2
    return 1
  fi
}

restore_runtime_state_snapshot() {
  if [ "$CONFIG_SNAPSHOT_TAKEN" -eq 1 ]; then
    restore_snapshot_dir "$CONFIG_ROLLBACK_DIR" "$CONFIG_DIR" "config/state" || return 1
  fi
  if [ "$STATE_SNAPSHOT_TAKEN" -eq 1 ]; then
    restore_snapshot_dir "$STATE_ROLLBACK_DIR" "$STATE_DIR" "state" || return 1
  fi
}

service_definition_path() {
  case "$(uname -s)" in
    Darwin) printf '%s\n' "${HOME}/Library/LaunchAgents/com.opencode-gateway.daemon.plist" ;;
    Linux) printf '%s\n' "${HOME}/.config/systemd/user/opencode-gateway.service" ;;
    *) return 1 ;;
  esac
}

wait_for_strict_readiness() {
  local cli_path="$1"
  local deadline=$((SECONDS + STARTUP_GRACE_SECONDS))
  local remaining
  local sleep_seconds

  while :; do
    if node "$cli_path" readiness --strict >/dev/null 2>&1; then
      echo "  Gateway passed strict readiness."
      return 0
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      break
    fi
    remaining=$((deadline - SECONDS))
    sleep_seconds="$READINESS_POLL_SECONDS"
    if [ "$remaining" -lt "$sleep_seconds" ]; then
      sleep_seconds="$remaining"
    fi
    sleep "$sleep_seconds"
  done

  echo "Error: Gateway did not pass strict readiness within ${STARTUP_GRACE_SECONDS} seconds." >&2
  return 1
}

remove_fresh_service_artifacts() {
  if [ "$SERVICE_INSTALL_ATTEMPTED" -ne 1 ] || [ "$SERVICE_PREEXISTED" -eq 1 ]; then
    return 0
  fi

  case "$(uname -s)" in
    Darwin)
      launchctl bootout "gui/$(id -u)/com.opencode-gateway.daemon" >/dev/null 2>&1 ||
        launchctl unload "$SERVICE_FILE" >/dev/null 2>&1 || true
      ;;
    Linux)
      systemctl --user disable --now opencode-gateway.service >/dev/null 2>&1 ||
        systemctl --user stop opencode-gateway.service >/dev/null 2>&1 || true
      ;;
  esac
  if ! rm -f -- "$SERVICE_FILE"; then
    echo "Rollback error: could not remove service definition ${SERVICE_FILE}." >&2
    return 1
  fi
  if [ "$(uname -s)" = "Linux" ]; then
    systemctl --user daemon-reload >/dev/null 2>&1 || true
  fi
  if [ -e "$SERVICE_FILE" ] || [ -L "$SERVICE_FILE" ]; then
    echo "Rollback error: service definition still exists at ${SERVICE_FILE}." >&2
    return 1
  fi
  echo "Fresh-install rollback removed the service definition created by this run." >&2
}

remove_fresh_global_cli() {
  if [ "$GLOBAL_CLI_INSTALL_ATTEMPTED" -ne 1 ] || [ "$GLOBAL_CLI_PREEXISTED" -eq 1 ]; then
    return 0
  fi

  npm uninstall -g opencode-gateway --ignore-scripts >/dev/null 2>&1 || true
  hash -r
  if [ -e "$GLOBAL_PACKAGE_DIR" ] || [ -L "$GLOBAL_PACKAGE_DIR" ] || [ -e "$GLOBAL_CLI_BIN" ] || [ -L "$GLOBAL_CLI_BIN" ]; then
    echo "Rollback error: npm left a global opencode-gateway package or CLI artifact behind." >&2
    return 1
  fi
  echo "Fresh-install rollback removed the global CLI created by this run." >&2
}

verify_service_loaded() {
  case "$(uname -s)" in
    Darwin)
      if ! launchctl print "gui/$(id -u)/com.opencode-gateway.daemon" >/dev/null 2>&1; then
        echo "Error: launchd did not load com.opencode-gateway.daemon" >&2
        return 1
      fi
      ;;
    Linux)
      if ! systemctl --user is-enabled --quiet opencode-gateway.service; then
        echo "Error: systemd user service opencode-gateway.service is not enabled" >&2
        return 1
      fi
      if ! systemctl --user is-active --quiet opencode-gateway.service; then
        echo "Error: systemd user service opencode-gateway.service is not active" >&2
        return 1
      fi
      ;;
    *)
      echo "Error: verified service installation is supported only on macOS and Linux" >&2
      return 1
      ;;
  esac
}

restore_previous_release() {
  local original_status="$1"
  local failed_dir
  local rollback_ok=1

  failed_dir="$FAILED_DIR"

  set +e
  trap - ERR
  echo >&2
  echo "Error: install/update failed after the service transaction started; beginning rollback." >&2

  if [ "$NEW_ACTIVE" -eq 1 ] && [ -f "${INSTALL_DIR}/dist/cli.js" ]; then
    node "${INSTALL_DIR}/dist/cli.js" stop >/dev/null 2>&1
  fi

  if [ "$EXISTING_INSTALL" -eq 0 ]; then
    remove_fresh_service_artifacts || rollback_ok=0
    remove_fresh_global_cli || rollback_ok=0
  fi

  if [ "$NEW_ACTIVE" -eq 1 ] && [ -d "$INSTALL_DIR" ]; then
    if ! mv "$INSTALL_DIR" "$failed_dir"; then
      echo "Rollback error: could not move failed release out of ${INSTALL_DIR}." >&2
      rollback_ok=0
    fi
  fi

  if [ "$HAD_PREVIOUS" -eq 1 ]; then
    if ! mv "$ROLLBACK_DIR" "$INSTALL_DIR"; then
      echo "Rollback error: could not restore ${ROLLBACK_DIR} to ${INSTALL_DIR}." >&2
      rollback_ok=0
    fi
  fi

  restore_runtime_state_snapshot || rollback_ok=0

  if [ "$EXISTING_INSTALL" -eq 1 ] && [ -f "${INSTALL_DIR}/dist/cli.js" ]; then
    npm install -g "$INSTALL_DIR" --ignore-scripts >/dev/null 2>&1 || rollback_ok=0
    node "${INSTALL_DIR}/dist/cli.js" install >/dev/null 2>&1 || rollback_ok=0
    verify_service_loaded || rollback_ok=0
    node "${INSTALL_DIR}/dist/cli.js" start >/dev/null 2>&1 || rollback_ok=0
    wait_for_strict_readiness "${INSTALL_DIR}/dist/cli.js" || rollback_ok=0
  fi

  if [ "$rollback_ok" -eq 1 ]; then
    if [ "$EXISTING_INSTALL" -eq 1 ]; then
      echo "Rollback complete: the previous release is restored, running, and strictly ready." >&2
    else
      echo "Fresh-install rollback complete: no global CLI or service definition from the failed run remains." >&2
    fi
    [ -d "$failed_dir" ] && echo "Failed release retained for inspection at ${failed_dir}." >&2
  else
    echo "Rollback did not fully recover or clean installer artifacts. Inspect ${INSTALL_DIR}, ${TRANSACTION_DIR}, and service logs before retrying." >&2
  fi
  exit "$original_status"
}

handle_error() {
  local status="$1"
  local line="$2"
  trap - ERR
  if [ "$TRANSACTION_ACTIVE" -eq 1 ]; then
    echo "Failure occurred near install.sh line ${line}." >&2
    restore_previous_release "$status"
  fi
  if [ "$NEW_ACTIVE" -eq 1 ]; then
    echo "Error: installation failed after the live release was changed but outside the rollback transaction (near install.sh line ${line})." >&2
  else
    echo "Error: installation failed before the live release was changed (near install.sh line ${line})." >&2
  fi
  exit "$status"
}

trap cleanup EXIT
trap 'handle_error $? $LINENO' ERR

case "$INSTALL_DIR" in
  ""|/|"$HOME") echo "Error: unsafe installation directory: ${INSTALL_DIR:-<empty>}" >&2; exit 1 ;;
esac
if [ -L "$INSTALL_DIR" ]; then
  echo "Error: installation directory must not be a symbolic link: ${INSTALL_DIR}" >&2
  exit 1
fi

# Node 22.13+ (except 23.0-23.3) is required for unflagged node:sqlite.
command -v node >/dev/null 2>&1 || { echo "Error: Node.js >=22.13 <23 or >=23.4 required. Install from https://nodejs.org"; exit 1; }
NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
NODE_MINOR="$(node -p "process.versions.node.split('.')[1]")"
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 13 ]; } || { [ "$NODE_MAJOR" -eq 23 ] && [ "$NODE_MINOR" -lt 4 ]; }; then
  echo "Error: Node.js >=22.13 <23 or >=23.4 required for node:sqlite. Current: $(node -v)"
  exit 1
fi

command -v npm >/dev/null 2>&1 || { echo "Error: npm is required"; exit 1; }
command -v tar >/dev/null 2>&1 || { echo "Error: tar is required"; exit 1; }
echo "  Node.js $(node -v)"
echo "  npm $(npm -v)"

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    echo "Error: sha256sum or shasum is required" >&2
    return 1
  fi
}

download_release_asset() {
  local name="$1"
  local url="https://github.com/${REPO}/releases/download/${INSTALL_REF}/${name}"
  if ! curl --fail --show-error --silent --location --retry 2 --output "${DOWNLOAD_DIR}/${name}" "$url"; then
    echo "Error: release ${INSTALL_REF} is absent or incomplete; could not download ${name}." >&2
    echo "Expected immutable release assets at https://github.com/${REPO}/releases/tag/${INSTALL_REF}" >&2
    return 1
  fi
}

mkdir -p "$(dirname "$INSTALL_DIR")"
create_transaction

if [ "$INSTALL_REF_KIND" = "tag" ]; then
  command -v curl >/dev/null 2>&1 || { echo "Error: curl is required for verified release downloads"; exit 1; }
  command -v cosign >/dev/null 2>&1 || {
    echo "Error: cosign is required to verify the signed release manifest." >&2
    echo "Install cosign from https://docs.sigstore.dev/cosign/system_config/installation/ and retry." >&2
    exit 1
  }
  DOWNLOAD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/opencode-gateway-release.XXXXXX")"
  ASSET_NAME="opencode-gateway-${INSTALL_REF}.tar.gz"
  download_release_asset SHA256SUMS
  download_release_asset SHA256SUMS.sigstore.json
  download_release_asset "$ASSET_NAME"

  CERT_IDENTITY="https://github.com/${REPO}/.github/workflows/ci.yml@refs/tags/${INSTALL_REF}"
  cosign verify-blob \
    --bundle "${DOWNLOAD_DIR}/SHA256SUMS.sigstore.json" \
    --certificate-identity "$CERT_IDENTITY" \
    --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
    "${DOWNLOAD_DIR}/SHA256SUMS" >/dev/null

  CHECKSUM_COUNT="$(awk -v name="$ASSET_NAME" '$2 == name { count++ } END { print count + 0 }' "${DOWNLOAD_DIR}/SHA256SUMS")"
  EXPECTED_SHA256="$(awk -v name="$ASSET_NAME" '$2 == name { print $1 }' "${DOWNLOAD_DIR}/SHA256SUMS")"
  if [ "$CHECKSUM_COUNT" -ne 1 ] || [[ ! "$EXPECTED_SHA256" =~ ^[0-9a-f]{64}$ ]]; then
    echo "Error: signed SHA256SUMS does not contain exactly one valid checksum for ${ASSET_NAME}" >&2
    exit 1
  fi
  ACTUAL_SHA256="$(sha256_file "${DOWNLOAD_DIR}/${ASSET_NAME}")"
  if [ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]; then
    echo "Error: checksum verification failed for ${ASSET_NAME}" >&2
    exit 1
  fi

  mkdir "$STAGING_DIR"
  tar -xzf "${DOWNLOAD_DIR}/${ASSET_NAME}" -C "$STAGING_DIR" --strip-components=1
  echo "  Verified signed manifest and SHA-256 for ${ASSET_NAME}"
else
  command -v git >/dev/null 2>&1 || { echo "Error: git is required for --unsafe-ref"; exit 1; }
  git init -q "$STAGING_DIR"
  git -C "$STAGING_DIR" remote add origin "$REMOTE_URL"
  git -C "$STAGING_DIR" fetch --depth 1 origin "$INSTALL_REF"
  git -C "$STAGING_DIR" -c advice.detachedHead=false checkout --detach FETCH_HEAD
  echo "  Unsafe source ref ${INSTALL_REF}; release signature/checksum verification was bypassed"
fi

STAGED_VERSION="$(node -e "const p=require(process.argv[1]); process.stdout.write(String(p.version||''))" "${STAGING_DIR}/package.json")"
if [ -z "$STAGED_VERSION" ]; then
  echo "Error: staged source has no package version" >&2
  exit 1
fi
if [ "$INSTALL_REF_KIND" = "tag" ] && [ "v${STAGED_VERSION}" != "$INSTALL_REF" ]; then
  echo "Error: verified archive package version v${STAGED_VERSION} does not match ${INSTALL_REF}" >&2
  exit 1
fi

if [ -d "$INSTALL_DIR" ]; then
  EXISTING_INSTALL=1
  [ -f "${INSTALL_DIR}/package.json" ] || { echo "Error: ${INSTALL_DIR} is not a recognizable Gateway installation"; exit 1; }
  if [ -d "${INSTALL_DIR}/.git" ] && [ -n "$(git -C "$INSTALL_DIR" status --porcelain)" ]; then
    echo "Error: ${INSTALL_DIR} has local changes. Commit, stash, or move them before updating."
    exit 1
  fi
fi

SERVICE_FILE="$(service_definition_path)" || {
  echo "Error: verified service installation is supported only on macOS and Linux" >&2
  exit 1
}
GLOBAL_PACKAGE_DIR="$(npm root -g)/opencode-gateway"
GLOBAL_CLI_BIN="$(npm prefix -g)/bin/opencode-gateway"
if [ -e "$GLOBAL_PACKAGE_DIR" ] || [ -L "$GLOBAL_PACKAGE_DIR" ] || [ -e "$GLOBAL_CLI_BIN" ] || [ -L "$GLOBAL_CLI_BIN" ]; then
  GLOBAL_CLI_PREEXISTED=1
fi
if [ -e "$SERVICE_FILE" ] || [ -L "$SERVICE_FILE" ]; then
  SERVICE_PREEXISTED=1
fi
case "$(uname -s)" in
  Darwin)
    if launchctl print "gui/$(id -u)/com.opencode-gateway.daemon" >/dev/null 2>&1; then
      SERVICE_PREEXISTED=1
    fi
    ;;
  Linux)
    if systemctl --user is-enabled --quiet opencode-gateway.service 2>/dev/null || systemctl --user is-active --quiet opencode-gateway.service 2>/dev/null; then
      SERVICE_PREEXISTED=1
    fi
    ;;
esac
if [ "$EXISTING_INSTALL" -eq 0 ] && [ "$GLOBAL_CLI_PREEXISTED" -eq 1 ]; then
  echo "Error: a global opencode-gateway CLI already exists but ${INSTALL_DIR} does not." >&2
  echo "Set OPENCODE_GATEWAY_INSTALL_DIR to its installation tree or remove the old global package before a fresh install." >&2
  exit 1
fi
if [ "$EXISTING_INSTALL" -eq 0 ] && [ "$SERVICE_PREEXISTED" -eq 1 ]; then
  echo "Error: an existing Gateway user service was detected at or under ${SERVICE_FILE}, but ${INSTALL_DIR} does not exist." >&2
  echo "Point OPENCODE_GATEWAY_INSTALL_DIR at the matching installation or remove the stale service definition explicitly." >&2
  exit 1
fi

echo
echo "  Building and checking staged release..."
(
  cd "$STAGING_DIR"
  npm ci --ignore-scripts
  npm rebuild esbuild --ignore-scripts=false
  npm run build
  npm run release:artifacts
)

TRANSACTION_ACTIVE=1

if [ "$EXISTING_INSTALL" -eq 1 ] && [ -f "${INSTALL_DIR}/dist/cli.js" ]; then
  echo
  echo "  Stopping the current Gateway service..."
  node "${INSTALL_DIR}/dist/cli.js" stop
fi

snapshot_runtime_state

if [ "$EXISTING_INSTALL" -eq 1 ]; then
  mv "$INSTALL_DIR" "$ROLLBACK_DIR"
  HAD_PREVIOUS=1
fi
mv "$STAGING_DIR" "$INSTALL_DIR"
NEW_ACTIVE=1

echo
echo "  Switched verified build into ${INSTALL_DIR}; configuring service..."
GLOBAL_CLI_INSTALL_ATTEMPTED=1
npm install -g "$INSTALL_DIR" --ignore-scripts
hash -r

EXPECTED_VERSION="$STAGED_VERSION"
CLI_VERSION="$("$GLOBAL_CLI_BIN" --version)"
if [ "$CLI_VERSION" != "$EXPECTED_VERSION" ]; then
  echo "Error: installed CLI reports '${CLI_VERSION}', expected ${EXPECTED_VERSION}" >&2
  false
fi

if [ "$EXISTING_INSTALL" -eq 1 ] && [ -f "$CONFIG_FILE" ]; then
  node "${INSTALL_DIR}/dist/cli.js" update --yes
elif [ "$NON_INTERACTIVE" -eq 1 ]; then
  node "${INSTALL_DIR}/dist/cli.js" setup --yes
else
  node "${INSTALL_DIR}/dist/cli.js" setup
fi

SERVICE_INSTALL_ATTEMPTED=1
node "${INSTALL_DIR}/dist/cli.js" install
verify_service_loaded
node "${INSTALL_DIR}/dist/cli.js" start
wait_for_strict_readiness "${INSTALL_DIR}/dist/cli.js"

TRANSACTION_ACTIVE=0

DASHBOARD_PORT="$(cd "$INSTALL_DIR" && node --input-type=module -e "import('./dist/config.js').then(m => process.stdout.write(String(m.getConfig().httpPort))).catch(() => process.stdout.write(process.env.OPENCODE_GATEWAY_HTTP_PORT || process.env.GATEWAY_HTTP_PORT || '4097'))")"

echo
echo "  OpenCode Gateway ${EXPECTED_VERSION} is installed, supervised, healthy, and ready."
echo "  Dashboard: http://localhost:${DASHBOARD_PORT}"
echo "  Logs:     ~/Library/Logs/opencode-gateway.log (macOS)"
echo "            journalctl --user -u opencode-gateway -f (Linux)"
if [ "$HAD_PREVIOUS" -eq 1 ]; then
  echo "  Rollback: previous verified installation retained at ${ROLLBACK_DIR}"
fi
echo
