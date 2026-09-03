#!/usr/bin/env bash
set -Eeuo pipefail

readonly HALFCLOUD_USER="halfcloudrunner"
readonly HALFCLOUD_HOME="/home/${HALFCLOUD_USER}"
readonly INSTALL_DIR="${HALFCLOUD_HOME}/halfcloud"
readonly DATA_DIR="${HALFCLOUD_HOME}/.halfcloud"
readonly REPOSITORY="mbukovy/halfcloud"
readonly SOURCE_URL="https://github.com/${REPOSITORY}/archive/refs/heads/main.tar.gz"

info() { printf '%s\n' "$1"; }
success() { printf '✓ %s\n' "$1"; }
fail() { printf 'Error: %s\n' "$1" >&2; exit 1; }
run_user() {
  runuser -u "${HALFCLOUD_USER}" -- env \
    HOME="${HALFCLOUD_HOME}" \
    USER="${HALFCLOUD_USER}" \
    XDG_RUNTIME_DIR="${runtime_dir}" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=${runtime_dir}/bus" \
    DOCKER_HOST="unix://${docker_socket}" \
    PATH="${HALFCLOUD_HOME}/bin:/usr/local/bin:/usr/bin:/bin" \
    "$@"
}

[[ "$(uname -s)" == "Linux" ]] || fail "HalfCloud 0.1 supports Linux only."
[[ "${EUID}" -eq 0 ]] || fail "Run the installer as root (for example: curl ... | sudo bash)."
[[ -r /etc/os-release ]] || fail "Cannot identify this Linux distribution. Ubuntu 22.04 or newer is required."
# shellcheck disable=SC1091
source /etc/os-release
[[ "${ID:-}" == "ubuntu" ]] || fail "HalfCloud 0.1 supports Ubuntu only (detected ${PRETTY_NAME:-unknown})."
major_version="${VERSION_ID%%.*}"
[[ "${major_version}" =~ ^[0-9]+$ ]] && (( major_version >= 22 )) || fail "Ubuntu 22.04 or newer is required (detected ${VERSION_ID:-unknown})."
[[ "$(uname -m)" == "x86_64" || "$(uname -m)" == "aarch64" ]] || fail "HalfCloud supports amd64 and arm64 servers only."
[[ -d /run/systemd/system ]] || fail "HalfCloud requires systemd."
[[ ! -S /var/run/docker.sock ]] || fail "A host Docker daemon is active. HalfCloud 0.1 requires a clean installation."

info "Installing HalfCloud with rootless Docker..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl dbus-user-session git uidmap slirp4netns fuse-overlayfs jq openssl gnupg

if ! id "${HALFCLOUD_USER}" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "${HALFCLOUD_USER}"
fi
runtime_uid="$(id -u "${HALFCLOUD_USER}")"
runtime_dir="/run/user/${runtime_uid}"
docker_socket="${runtime_dir}/docker.sock"
if ! grep -q "^${HALFCLOUD_USER}:" /etc/subuid; then printf '%s:100000:65536\n' "${HALFCLOUD_USER}" >> /etc/subuid; fi
if ! grep -q "^${HALFCLOUD_USER}:" /etc/subgid; then printf '%s:100000:65536\n' "${HALFCLOUD_USER}" >> /etc/subgid; fi
loginctl enable-linger "${HALFCLOUD_USER}"
systemctl start "user@${runtime_uid}.service"
success "Dedicated ${HALFCLOUD_USER} user configured"

if ! command -v dockerd-rootless-setuptool.sh >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
apt-get install -y -qq docker-ce-rootless-extras docker-compose-plugin
systemctl disable --now docker.service docker.socket >/dev/null 2>&1 || true
rm -f /var/run/docker.sock
run_user dockerd-rootless-setuptool.sh install --force
run_user systemctl --user enable --now docker.service
for _ in {1..30}; do
  [[ -S "${docker_socket}" ]] && run_user docker info >/dev/null 2>&1 && break
  sleep 1
done
[[ -S "${docker_socket}" ]] || fail "Rootless Docker did not create ${docker_socket}."
[[ "$(stat -c %U "${docker_socket}")" == "${HALFCLOUD_USER}" ]] || fail "The Docker socket is not owned by ${HALFCLOUD_USER}."
run_user docker info --format '{{json .SecurityOptions}}' | grep -q rootless || fail "Docker did not report rootless mode."
success "Rootless Docker is running"

node_major="0"
if command -v node >/dev/null 2>&1; then node_major="$(node --version | tr -d v | cut -d. -f1)"; fi
if (( node_major < 22 )); then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi

temporary_dir="$(mktemp -d)"
trap 'rm -rf "${temporary_dir}"' EXIT
curl -fsSL "${SOURCE_URL}" -o "${temporary_dir}/source.tar.gz"
tar -xzf "${temporary_dir}/source.tar.gz" -C "${temporary_dir}"
rm -rf "${INSTALL_DIR}"
install -d -o "${HALFCLOUD_USER}" -g "${HALFCLOUD_USER}" -m 755 "${INSTALL_DIR}"
cp -a "${temporary_dir}/halfcloud-main/." "${INSTALL_DIR}/"
chown -R "${HALFCLOUD_USER}:${HALFCLOUD_USER}" "${INSTALL_DIR}"
run_user npm --prefix "${INSTALL_DIR}" ci
run_user npm --prefix "${INSTALL_DIR}" run build
run_user npm --prefix "${INSTALL_DIR}" prune --omit=dev
install -d -o "${HALFCLOUD_USER}" -g "${HALFCLOUD_USER}" -m 700 \
  "${DATA_DIR}/config" "${DATA_DIR}/data" "${DATA_DIR}/apps" "${DATA_DIR}/repositories" "${DATA_DIR}/logs" "${DATA_DIR}/secrets"

public_ip="$(curl --ipv4 -fsS --max-time 10 https://api.ipify.org || curl --ipv4 -fsS --max-time 10 https://ifconfig.me/ip || true)"
public_ip="${public_ip//$'\n'/}"
[[ "${public_ip}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || fail "Could not determine the VPS public IPv4 address."
IFS='.' read -r -a octets <<< "${public_ip}"
for octet in "${octets[@]}"; do (( 10#${octet} <= 255 )) || fail "Received an invalid public IPv4 address."; done
base_domain="${public_ip}.nip.io"
hostname="halfcloud.${base_domain}"
random_hex="$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n' | tr '[:lower:]' '[:upper:]')"
access_code="${random_hex:0:6}-${random_hex:6:6}"
session_secret="$(openssl rand -hex 32)"
printf '%s\n' "${access_code}" > "${DATA_DIR}/secrets/access-code"
cat > "${DATA_DIR}/config/service.env" <<EOF
NODE_ENV=production
PORT=9000
HOME=${HALFCLOUD_HOME}
HALFCLOUD_DATA_DIR=${DATA_DIR}/data
HALFCLOUD_APPS_DIR=${DATA_DIR}/apps
HALFCLOUD_REPOSITORIES_DIR=${DATA_DIR}/repositories
HALFCLOUD_ACCESS_CODE_FILE=${DATA_DIR}/secrets/access-code
HALFCLOUD_SESSION_SECRET=${session_secret}
HALFCLOUD_HOSTNAME=${hostname}
HALFCLOUD_BASE_DOMAIN=${base_domain}
DOCKER_HOST=unix://${docker_socket}
EOF
chown -R "${HALFCLOUD_USER}:${HALFCLOUD_USER}" "${DATA_DIR}"
chmod 600 "${DATA_DIR}/secrets/access-code" "${DATA_DIR}/config/service.env"

cat > /etc/systemd/system/halfcloud.service <<EOF
[Unit]
Description=HalfCloud control plane
After=network-online.target user@${runtime_uid}.service
Wants=network-online.target
Requires=user@${runtime_uid}.service

[Service]
Type=simple
User=${HALFCLOUD_USER}
Group=${HALFCLOUD_USER}
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${DATA_DIR}/config/service.env
ExecStart=/usr/bin/node ${INSTALL_DIR}/dist/backend/server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=${DATA_DIR}
RestrictSUIDSGID=true

[Install]
WantedBy=multi-user.target
EOF

curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt -o /etc/apt/sources.list.d/caddy-stable.list
apt-get update -qq
apt-get install -y -qq caddy
install -d -m 755 /etc/caddy
cat > /etc/caddy/Caddyfile <<EOF
{
  admin 127.0.0.1:2019
}

${hostname} {
  encode zstd gzip
  reverse_proxy 127.0.0.1:9000
}
EOF
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl enable --now caddy
systemctl daemon-reload
systemctl enable --now halfcloud
success "HalfCloud and Caddy services installed"

test_name="halfcloud-install-test"
run_user docker rm -f "${test_name}" >/dev/null 2>&1 || true
run_user docker run -d --name "${test_name}" -p 127.0.0.1:19999:80 nginx:alpine >/dev/null
for _ in {1..30}; do curl -fsS --max-time 2 http://127.0.0.1:19999/ >/dev/null 2>&1 && break; sleep 1; done
curl -fsS --max-time 2 http://127.0.0.1:19999/ >/dev/null || fail "Rootless Docker could not expose a localhost test port."
run_user docker rm -f "${test_name}" >/dev/null
success "Rootless test container passed"

for _ in {1..60}; do curl -fsS --max-time 2 http://127.0.0.1:9000/api/health >/dev/null 2>&1 && break; sleep 2; done
curl -fsS --max-time 2 http://127.0.0.1:9000/api/health >/dev/null || { journalctl -u halfcloud --no-pager -n 50 >&2; fail "HalfCloud did not become healthy."; }
systemctl is-active --quiet caddy || fail "Caddy is not running."
if id -nG "${HALFCLOUD_USER}" | tr ' ' '\n' | grep -Eq '^(sudo|docker)$'; then fail "The ${HALFCLOUD_USER} user received a prohibited privileged group."; fi
success "Runtime identity and service checks passed"

https_ready=false
for _ in {1..60}; do
  if curl -fsS --max-time 5 "https://${hostname}/api/health" >/dev/null 2>&1; then https_ready=true; break; fi
  sleep 2
done
[[ "${https_ready}" == "true" ]] || fail "HTTPS did not become available. Verify that inbound ports 80 and 443 are open, then rerun the installer."
success "HTTPS configured"

info ""
info "HalfCloud is ready."
info "https://${hostname}"
info ""
info "Access code:"
info "${access_code}"
