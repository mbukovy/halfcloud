#!/usr/bin/env bash
set -Eeuo pipefail

readonly INSTALL_DIR="/opt/halfcloud"
readonly REPOSITORY="mbukovy/halfcloud"
readonly RAW_URL="https://raw.githubusercontent.com/${REPOSITORY}/main"

info() { printf '%s\n' "$1"; }
success() { printf '✓ %s\n' "$1"; }
fail() { printf 'Error: %s\n' "$1" >&2; exit 1; }

if [[ "$(uname -s)" != "Linux" ]]; then
  fail "HalfCloud 0.1 supports Linux only."
fi

if [[ "${EUID}" -ne 0 ]]; then
  fail "Run the installer as root (for example: curl ... | sudo bash)."
fi

if [[ ! -r /etc/os-release ]]; then
  fail "Cannot identify this Linux distribution. Ubuntu 22.04 or newer is required."
fi

# shellcheck disable=SC1091
source /etc/os-release
if [[ "${ID:-}" != "ubuntu" ]]; then
  fail "HalfCloud 0.1 supports Ubuntu only (detected ${PRETTY_NAME:-unknown})."
fi

major_version="${VERSION_ID%%.*}"
if [[ ! "${major_version}" =~ ^[0-9]+$ ]] || (( major_version < 22 )); then
  fail "Ubuntu 22.04 or newer is required (detected ${VERSION_ID:-unknown})."
fi

info "Installing HalfCloud..."
info ""

export DEBIAN_FRONTEND=noninteractive
if ! command -v curl >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y -qq curl ca-certificates
fi

if ! command -v docker >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
  success "Docker installed"
else
  systemctl enable --now docker >/dev/null 2>&1 || true
  success "Docker available"
fi

if ! docker compose version >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y -qq docker-compose-plugin || fail "Docker Compose v2 is required."
fi

install -d -m 700 "${INSTALL_DIR}/data"
temporary_dir="$(mktemp -d)"
trap 'rm -rf "${temporary_dir}"' EXIT
curl -fsSL "${RAW_URL}/compose.yaml" -o "${temporary_dir}/compose.yaml"
curl -fsSL "${RAW_URL}/Caddyfile" -o "${temporary_dir}/Caddyfile"
install -m 644 "${temporary_dir}/compose.yaml" "${INSTALL_DIR}/compose.yaml"
install -m 644 "${temporary_dir}/Caddyfile" "${INSTALL_DIR}/Caddyfile"

public_ip="$(curl --ipv4 -fsS --max-time 10 https://api.ipify.org || curl --ipv4 -fsS --max-time 10 https://ifconfig.me/ip || true)"
public_ip="${public_ip//$'\n'/}"
if [[ ! "${public_ip}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
  fail "Could not determine the VPS public IPv4 address."
fi
IFS='.' read -r -a octets <<< "${public_ip}"
for octet in "${octets[@]}"; do
  if (( 10#${octet} > 255 )); then fail "Received an invalid public IPv4 address."; fi
done

hostname="${public_ip//./-}.sslip.io"
random_hex="$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n' | tr '[:lower:]' '[:upper:]')"
access_code="${random_hex:0:6}-${random_hex:6:6}"
session_secret="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
printf '%s\n' "${access_code}" > "${INSTALL_DIR}/data/access-code"
chmod 600 "${INSTALL_DIR}/data/access-code"
cat > "${INSTALL_DIR}/.env" <<EOF
HALFCLOUD_HOSTNAME=${hostname}
HALFCLOUD_SESSION_SECRET=${session_secret}
HALFCLOUD_IMAGE=ghcr.io/${REPOSITORY}:latest
EOF
chmod 600 "${INSTALL_DIR}/.env"
success "HalfCloud files installed"

docker compose -f "${INSTALL_DIR}/compose.yaml" --env-file "${INSTALL_DIR}/.env" pull
docker compose -f "${INSTALL_DIR}/compose.yaml" --env-file "${INSTALL_DIR}/.env" up -d --remove-orphans

for _ in {1..60}; do
  if docker compose -f "${INSTALL_DIR}/compose.yaml" --env-file "${INSTALL_DIR}/.env" exec -T halfcloud node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    success "HalfCloud started"
    break
  fi
  sleep 2
done
if ! docker compose -f "${INSTALL_DIR}/compose.yaml" --env-file "${INSTALL_DIR}/.env" exec -T halfcloud node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
  docker compose -f "${INSTALL_DIR}/compose.yaml" --env-file "${INSTALL_DIR}/.env" logs --tail=40 >&2
  fail "HalfCloud did not become healthy."
fi

success "Caddy started"
https_ready=false
for _ in {1..60}; do
  if curl -fsS --max-time 5 "https://${hostname}/api/health" >/dev/null 2>&1; then
    https_ready=true
    break
  fi
  sleep 2
done
if [[ "${https_ready}" != "true" ]]; then
  docker compose -f "${INSTALL_DIR}/compose.yaml" --env-file "${INSTALL_DIR}/.env" logs --tail=40 caddy >&2
  fail "HTTPS did not become available. Verify that inbound ports 80 and 443 are open, then rerun the installer."
fi
success "HTTPS configured"

info ""
info "HalfCloud is ready."
info ""
info "https://${hostname}"
info ""
info "Access code:"
info "${access_code}"
