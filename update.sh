#!/usr/bin/env bash
set -Eeuo pipefail

readonly HALFCLOUD_USER="halfcloudrunner"
readonly HALFCLOUD_HOME="/home/${HALFCLOUD_USER}"
readonly INSTALL_DIR="${HALFCLOUD_HOME}/halfcloud"
readonly BACKUP_DIR="${INSTALL_DIR}.previous"
readonly REPOSITORY="mbukovy/halfcloud"
readonly SOURCE_URL="https://github.com/${REPOSITORY}/archive/refs/heads/main.tar.gz"

info() { printf '%s\n' "$1"; }
success() { printf '✓ %s\n' "$1"; }
warning() { printf 'Warning: %s\n' "$1" >&2; }
fail() { printf 'Error: %s\n' "$1" >&2; exit 1; }
run_user() {
  runuser -u "${HALFCLOUD_USER}" -- env \
    HOME="${HALFCLOUD_HOME}" \
    USER="${HALFCLOUD_USER}" \
    PATH="${HALFCLOUD_HOME}/bin:/usr/local/bin:/usr/bin:/bin" \
    "$@"
}

[[ "$(uname -s)" == "Linux" ]] || fail "HalfCloud updates support Linux only."
[[ "${EUID}" -eq 0 ]] || fail "Run the updater as root (for example: curl ... | sudo bash)."
id "${HALFCLOUD_USER}" >/dev/null 2>&1 || fail "The ${HALFCLOUD_USER} account does not exist. Install HalfCloud first."
[[ -d "${INSTALL_DIR}" ]] || fail "HalfCloud is not installed at ${INSTALL_DIR}."
[[ -f "${INSTALL_DIR}/package.json" ]] || fail "The existing HalfCloud installation is incomplete."
[[ -f /etc/systemd/system/halfcloud.service ]] || fail "halfcloud.service is not installed."
systemctl is-active --quiet halfcloud.service || fail "halfcloud.service is not running; resolve that before updating."
command -v curl >/dev/null 2>&1 || fail "curl is required."
command -v npm >/dev/null 2>&1 || fail "npm is required."
command -v flock >/dev/null 2>&1 || fail "flock is required."

exec 9>/run/lock/halfcloud-update.lock
flock -n 9 || fail "Another HalfCloud update is already running."

temporary_dir="$(mktemp -d)"
staging_dir="$(mktemp -d "${HALFCLOUD_HOME}/halfcloud-update.XXXXXX")"
service_stopped=false
switched=false
update_succeeded=false

cleanup() {
  exit_code=$?
  trap - EXIT

  if [[ "${switched}" == "true" && "${update_succeeded}" != "true" ]]; then
    warning "Update failed after stopping HalfCloud; restoring the previous release."
    systemctl stop halfcloud.service >/dev/null 2>&1 || true
    rm -rf -- "${INSTALL_DIR}"
    if [[ -d "${BACKUP_DIR}" ]]; then
      mv "${BACKUP_DIR}" "${INSTALL_DIR}"
      chown -R "${HALFCLOUD_USER}:${HALFCLOUD_USER}" "${INSTALL_DIR}"
      if systemctl start halfcloud.service; then
        warning "The previous HalfCloud release was restored and started."
      else
        warning "Rollback was restored on disk but halfcloud.service could not be started."
      fi
    else
      warning "The previous release backup is missing; automatic rollback was not possible."
    fi
  elif [[ "${service_stopped}" == "true" && "${update_succeeded}" != "true" ]]; then
    warning "Update was interrupted; restarting the unchanged HalfCloud release."
    systemctl start halfcloud.service || warning "halfcloud.service could not be restarted."
  fi

  rm -rf -- "${temporary_dir}" "${staging_dir}"
  exit "${exit_code}"
}
trap cleanup EXIT

info "Downloading the latest HalfCloud release..."
curl -fsSL --retry 3 "${SOURCE_URL}" -o "${temporary_dir}/source.tar.gz"
tar -xzf "${temporary_dir}/source.tar.gz" --strip-components=1 -C "${staging_dir}"
[[ -f "${staging_dir}/package.json" && -f "${staging_dir}/backend/server.ts" ]] || fail "Downloaded release is incomplete."
chown -R "${HALFCLOUD_USER}:${HALFCLOUD_USER}" "${staging_dir}"

info "Installing dependencies..."
run_user npm --prefix "${staging_dir}" ci --ignore-scripts --prefer-offline --no-audit --no-fund
info "Building the update..."
run_user npm --prefix "${staging_dir}" run build
info "Removing development dependencies..."
run_user npm --prefix "${staging_dir}" prune --omit=dev --ignore-scripts --no-audit --no-fund
[[ -f "${staging_dir}/dist/backend/server.js" && -f "${staging_dir}/dist/public/index.html" ]] || fail "The updated release did not build correctly."
success "Update built while the current HalfCloud release remained online"

info "Stopping only the HalfCloud control plane for the release swap..."
service_stopped=true
systemctl stop halfcloud.service
rm -rf -- "${BACKUP_DIR}"
mv "${INSTALL_DIR}" "${BACKUP_DIR}"
switched=true
mv "${staging_dir}" "${INSTALL_DIR}"
chown -R "${HALFCLOUD_USER}:${HALFCLOUD_USER}" "${INSTALL_DIR}"

systemctl start halfcloud.service
healthy=false
for _ in {1..30}; do
  if curl -fsS --max-time 2 http://127.0.0.1:9000/api/health >/dev/null 2>&1; then
    healthy=true
    break
  fi
  sleep 2
done
[[ "${healthy}" == "true" ]] || { journalctl -u halfcloud --no-pager -n 50 >&2; fail "The updated HalfCloud release did not become healthy."; }

update_succeeded=true
service_stopped=false
switched=false
rm -rf -- "${BACKUP_DIR}"
success "HalfCloud was updated successfully"
info "Docker, Caddy, and application containers were not restarted."
