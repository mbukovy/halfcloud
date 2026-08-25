# HalfCloud 0.1

HalfCloud turns a fresh Ubuntu VPS into an HTTPS-secured, AI-managed Docker host. It combines a Vue dashboard, a Vercel AI SDK tool-loop agent, Azure OpenAI, and Docker Engine API operations.

## Install

On a fresh Ubuntu 22.04 or newer VPS, as root:

```bash
curl -fsSL https://raw.githubusercontent.com/mbukovy/halfcloud/main/install.sh | bash
```

The installer prints an automatic `sslip.io` HTTPS URL and a permanent random access code. Inbound TCP ports 80 and 443 must be open. Published application ports, such as 8080 for nginx, must also be allowed by the VPS firewall or cloud security group.

## First Run

1. Open the printed HTTPS URL and sign in with the access code.
2. Enter an Azure OpenAI endpoint, API key, and deployment name. The default deployment is `gpt-5.6-sol`.
3. Ask: `Run nginx on port 8080`.

Only containers created by HalfCloud, labeled `halfcloud.managed=true`, can be changed through HalfCloud. Docker remains the source of truth.

## Local Development

Requirements: Node.js 22+, Docker, and permission to access `/var/run/docker.sock`.

```bash
npm install
HALFCLOUD_ACCESS_CODE=LOCAL-DEV \
HALFCLOUD_DATA_DIR="$PWD/data" \
npm run dev
```

Open `http://localhost:5173`. Vite proxies API requests to the backend on port 3000.

Useful checks:

```bash
npm run typecheck
npm run build
docker build -t halfcloud:local .
```

To test the production Compose stack locally, set `HALFCLOUD_IMAGE=halfcloud:local` in `/opt/halfcloud/.env` after building the image.

## Data and Operations

The VPS deployment stores:

```text
/opt/halfcloud/
├── .env                 # hostname and session signing secret
├── Caddyfile
├── compose.yaml
└── data/
    ├── access-code      # mode 0600
    └── settings.json    # Azure credentials, mode 0600
```

Common administrative commands:

```bash
docker compose -f /opt/halfcloud/compose.yaml --env-file /opt/halfcloud/.env ps
docker compose -f /opt/halfcloud/compose.yaml --env-file /opt/halfcloud/.env logs -f
docker compose -f /opt/halfcloud/compose.yaml --env-file /opt/halfcloud/.env restart
```

## Security Scope

HalfCloud is designed for one trusted administrator on an experimental or small VPS. The service mounts the Docker socket and consequently has root-equivalent host control. The admin UI is exposed only through Caddy, browser sessions use HTTP-only secure cookies, Azure credentials are never returned through the API, deletion requires confirmation, and lifecycle tools reject containers without the HalfCloud managed label.
