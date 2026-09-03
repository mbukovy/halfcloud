#!/usr/bin/env bash
set -uo pipefail

readonly CONFIRMATION="UNINSTALL HALFCLOUD"
readonly HALFCLOUD_USER="halfcloudrunner"
readonly HALFCLOUD_HOME="/home/${HALFCLOUD_USER}"

info() { printf '%s\n' "$1"; }
success() { printf '✓ %s\n' "$1"; }
warning() { printf 'Warning: %s\n' "$1" >&2; }
fail() { printf 'Error: %s\n' "$1" >&2; exit 1; }

if [[ "${EUID}" -ne 0 ]]; then
  printf 'Error: Run the uninstaller as root (for example: sudo ./uninstall.sh).\n' >&2
  exit 1
fi

invoking_user="${SUDO_USER:-}"
terminal_path="$(tty 2>/dev/null || true)"
terminal_user=""
if [[ -n "${terminal_path}" && "${terminal_path}" != "not a tty" ]]; then
  terminal_user="$(stat -c %U "${terminal_path}" 2>/dev/null || true)"
fi
if [[ "${invoking_user}" == "${HALFCLOUD_USER}" || "${terminal_user}" == "${HALFCLOUD_USER}" ]]; then
  printf 'Error: Do not run the uninstaller from a %s login session.\n' "${HALFCLOUD_USER}" >&2
  printf 'Log in as root or a different sudo-capable user, then run it again.\n' >&2
  exit 1
fi

cat >&2 <<'EOF'

WARNING: This will completely uninstall HalfCloud from this server.

All HalfCloud applications, containers, images, volumes, configuration,
credentials, logs, and data will be permanently deleted.
Shared host audit logs, such as the system journal and APT history, are retained.

The dedicated halfcloudrunner user and its home directory will be deleted.
Docker, Caddy, Node.js, their package repositories, and all host
Docker/containerd data will also be removed because HalfCloud 0.1 is intended
for a dedicated, clean server.

This operation is irreversible. Back up anything you want to keep before
continuing. Do not continue if this server has Docker, Caddy, or Node.js state
that was not created for HalfCloud.
EOF

if [[ ! -r /dev/tty ]]; then
  printf 'Error: An interactive terminal is required for confirmation.\n' >&2
  exit 1
fi

printf '\nType %s to continue: ' "${CONFIRMATION}" >/dev/tty
IFS= read -r response </dev/tty || response=""
if [[ "${response}" != "${CONFIRMATION}" ]]; then
  info "Uninstall cancelled."
  exit 1
fi

info "Stopping HalfCloud services..."
systemctl disable --now halfcloud.service >/dev/null 2>&1 || true
rm -f /etc/systemd/system/halfcloud.service
rm -f /etc/systemd/system/multi-user.target.wants/halfcloud.service
rm -f /run/lock/halfcloud-update.lock
systemctl daemon-reload
systemctl reset-failed halfcloud.service >/dev/null 2>&1 || true

info "Stopping rootless Docker and removing the HalfCloud account and data..."
runtime_uid=""
if id "${HALFCLOUD_USER}" >/dev/null 2>&1; then
  runtime_uid="$(id -u "${HALFCLOUD_USER}")"
  runtime_dir="/run/user/${runtime_uid}"

  runuser -u "${HALFCLOUD_USER}" -- env \
    HOME="${HALFCLOUD_HOME}" \
    XDG_RUNTIME_DIR="${runtime_dir}" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=${runtime_dir}/bus" \
    systemctl --user disable --now docker.service >/dev/null 2>&1 || true

  loginctl disable-linger "${HALFCLOUD_USER}" >/dev/null 2>&1 || true
  loginctl terminate-user "${HALFCLOUD_USER}" >/dev/null 2>&1 || true
  pkill -TERM -u "${runtime_uid}" >/dev/null 2>&1 || true
  sleep 1
  pkill -KILL -u "${runtime_uid}" >/dev/null 2>&1 || true
  userdel --force --remove "${HALFCLOUD_USER}" >/dev/null 2>&1 || true
fi

rm -rf -- "${HALFCLOUD_HOME}"
rm -f "/var/lib/systemd/linger/${HALFCLOUD_USER}"
if [[ -n "${runtime_uid}" ]]; then
  rm -rf -- "/run/user/${runtime_uid}"
fi
if [[ -f /etc/subuid ]]; then
  sed -i "/^${HALFCLOUD_USER}:/d" /etc/subuid
fi
if [[ -f /etc/subgid ]]; then
  sed -i "/^${HALFCLOUD_USER}:/d" /etc/subgid
fi
if getent group "${HALFCLOUD_USER}" >/dev/null 2>&1; then
  groupdel "${HALFCLOUD_USER}" >/dev/null 2>&1 || warning "Could not remove the ${HALFCLOUD_USER} group."
fi

info "Removing Docker and container state..."
systemctl disable --now docker.service docker.socket containerd.service >/dev/null 2>&1 || true
rm -f /var/run/docker.sock /run/docker.sock
rm -rf -- /var/lib/docker /var/lib/containerd /etc/docker /etc/containerd /run/docker /run/containerd

info "Removing Caddy configuration and state..."
systemctl disable --now caddy.service >/dev/null 2>&1 || true
rm -rf -- /etc/caddy /var/lib/caddy /var/log/caddy /run/caddy

info "Removing packages installed for HalfCloud..."
packages=(
  caddy
  containerd.io
  docker-buildx-plugin
  docker-ce
  docker-ce-cli
  docker-ce-rootless-extras
  docker-compose-plugin
  docker-model-plugin
  docker-scan-plugin
  nodejs
)
installed_packages=()
for package in "${packages[@]}"; do
  if dpkg-query -W -f='${db:Status-Status}' "${package}" 2>/dev/null | grep -q '^installed$'; then
    installed_packages+=("${package}")
  fi
done
if (( ${#installed_packages[@]} > 0 )); then
  DEBIAN_FRONTEND=noninteractive apt-get purge -y "${installed_packages[@]}" || warning "Some packages could not be removed."
fi
if id caddy >/dev/null 2>&1; then
  userdel caddy >/dev/null 2>&1 || warning "Could not remove the caddy system account."
fi
if getent group caddy >/dev/null 2>&1; then
  groupdel caddy >/dev/null 2>&1 || warning "Could not remove the caddy group."
fi
if getent group docker >/dev/null 2>&1; then
  groupdel docker >/dev/null 2>&1 || warning "Could not remove the docker group."
fi

info "Removing package repositories..."
repository_files=(
  /etc/apt/sources.list.d/caddy-stable.list
  /etc/apt/sources.list.d/caddy-stable.list.save
  /etc/apt/sources.list.d/caddy-stable.sources
  /etc/apt/sources.list.d/docker.list
  /etc/apt/sources.list.d/docker.list.save
  /etc/apt/sources.list.d/docker.sources
  /etc/apt/sources.list.d/nodesource.list
  /etc/apt/sources.list.d/nodesource.list.save
  /etc/apt/sources.list.d/nodesource.sources
  /etc/apt/keyrings/docker.asc
  /etc/apt/keyrings/docker.gpg
  /etc/apt/preferences.d/nodejs
  /etc/apt/preferences.d/nsolid
  /etc/apt/keyrings/caddy-stable-archive-keyring.gpg
  /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  /usr/share/keyrings/nodesource.gpg
  /usr/share/keyrings/nodesource-repo.gpg
)
rm -f "${repository_files[@]}"
apt-get update -qq || warning "APT package metadata could not be refreshed."

systemctl daemon-reload
systemctl reset-failed >/dev/null 2>&1 || true

cleanup_failed=false
id "${HALFCLOUD_USER}" >/dev/null 2>&1 && { warning "The ${HALFCLOUD_USER} account is still present."; cleanup_failed=true; }
getent group "${HALFCLOUD_USER}" >/dev/null 2>&1 && { warning "The ${HALFCLOUD_USER} group is still present."; cleanup_failed=true; }
[[ -e "${HALFCLOUD_HOME}" ]] && { warning "${HALFCLOUD_HOME} is still present."; cleanup_failed=true; }
[[ -e /etc/systemd/system/halfcloud.service || -L /etc/systemd/system/multi-user.target.wants/halfcloud.service ]] && { warning "halfcloud.service was not completely removed."; cleanup_failed=true; }
for package in "${packages[@]}"; do
  if dpkg-query -W -f='${db:Status-Status}' "${package}" 2>/dev/null | grep -q '^installed$'; then
    warning "Package ${package} is still installed."
    cleanup_failed=true
  fi
done
for path in "${repository_files[@]}" /etc/caddy /var/lib/caddy /var/lib/docker /var/lib/containerd /etc/docker /etc/containerd; do
  [[ ! -e "${path}" ]] || { warning "${path} is still present."; cleanup_failed=true; }
done
for service in halfcloud.service caddy.service docker.service docker.socket containerd.service; do
  systemctl is-active --quiet "${service}" || continue
  warning "${service} is still active."
  cleanup_failed=true
done
[[ "${cleanup_failed}" == "false" ]] || fail "Uninstall was incomplete. Resolve the warnings above, then run the uninstaller again."

success "HalfCloud and its data have been removed."
info "The shared prerequisite packages installed by apt were left in place because other system software may use them."
