# HalfCloud

HalfCloud is an open-source, self-hosted platform for deploying and operating containerized applications on your own server through a simple AI conversation.

Bring an Ubuntu VPS, install HalfCloud, and describe what you want to run. HalfCloud can deploy Docker images, manage their lifecycle, inspect logs, and help diagnose resource problems without turning every project into an infrastructure project.

It is built for developers, indie hackers, AI builders, and small teams who want the affordability and control of a VPS without spending their time living in SSH.

## Your servers. Zero complexity.

Building software has changed dramatically. You can prototype an application in an afternoon, push an image to a registry, and then suddenly find yourself dealing with Linux servers, Docker commands, port mappings, environment variables, logs, and restarts.

**HalfCloud is built for that last mile.**

You describe the outcome:

> Run nginx on port 8080.

> Start my API with these environment variables.

> Why did this container stop?

> Which service is using all the memory?

HalfCloud translates the conversation into focused infrastructure operations on your server.

```text
Your Docker image
        |
        v
     HalfCloud
        |
        v
     Your VPS
        |
        v
  Running service
```

No Kubernetes. No giant control plane. No YAML archaeology. **No DevOps degree required.**

A modest VPS can run a surprising amount of software. The difficult part is not renting one; it is operating it confidently. HalfCloud gives you a practical middle ground between "I just want to put this online" and "apparently we need a platform engineering team now."

Use it to run web applications, APIs, automation tools, AI agents, internal services, open-source software, side projects, and experiments that unexpectedly found users. If it ships as a Docker image, HalfCloud can help you get it running and keep an eye on it.

Your code can move fast. Your infrastructure should not slow it down.

## How HalfCloud works

HalfCloud runs on a single Ubuntu server alongside Docker. Its Vue dashboard connects to a Node.js backend, where an AI agent turns natural-language requests into a deliberately small set of Docker operations.

The agent can:

- Pull and run Docker images with port mappings and environment variables
- List, start, stop, restart, and remove HalfCloud-managed containers
- Read recent container logs
- Inspect container CPU and memory usage
- Inspect host CPU, memory, disk usage, and uptime

Docker remains the source of truth. HalfCloud labels every container it creates with `halfcloud.managed=true`, and its lifecycle tools reject containers without that label. The model does not receive a general-purpose shell or unrestricted SSH session; it can act only through the tools HalfCloud exposes. Destructive actions require confirmation.

This guardrail limits the AI's operating surface, but it is not a security boundary between HalfCloud and the host. HalfCloud mounts the Docker socket, which gives the application root-equivalent control of the server. It is designed for one trusted administrator on an experimental or small VPS, not for untrusted users or multi-tenant hosting.

The HalfCloud interface is protected by an access code and served through Caddy over HTTPS. Sessions use signed, HTTP-only cookies, login attempts are rate-limited, and your Azure OpenAI API key is stored locally with restricted file permissions and is never returned by the settings API. Prompts and tool calls are processed by the Azure OpenAI endpoint you configure.

### Install

On a fresh Ubuntu 22.04 or newer VPS, run as root:

```bash
curl -fsSL https://raw.githubusercontent.com/mbukovy/halfcloud/main/install.sh | bash
```

The installer sets up Docker, HalfCloud, and Caddy, then prints an automatic `sslip.io` HTTPS URL and a permanent random access code. Inbound TCP ports 80 and 443 must be open. Any ports published for your applications must also be allowed by the VPS firewall or cloud security group.

### First run

1. Open the printed HTTPS URL and sign in with the access code.
2. Enter your Azure OpenAI endpoint, API key, and deployment name. The default deployment name is `gpt-5.6-sol`.
3. Ask HalfCloud to run a service, for example: `Run nginx on port 8080`.

### Local development

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

### Data and operations

The VPS deployment stores its configuration under `/opt/halfcloud`:

```text
/opt/halfcloud/
|-- .env                 # hostname and session signing secret
|-- Caddyfile
|-- compose.yaml
`-- data/
    |-- access-code      # mode 0600
    `-- settings.json    # Azure credentials, mode 0600
```

Common administrative commands:

```bash
docker compose -f /opt/halfcloud/compose.yaml --env-file /opt/halfcloud/.env ps
docker compose -f /opt/halfcloud/compose.yaml --env-file /opt/halfcloud/.env logs -f
docker compose -f /opt/halfcloud/compose.yaml --env-file /opt/halfcloud/.env restart
```

HalfCloud is an early project with a deliberately focused scope: one trusted administrator, one Docker host, and container deployments from existing images. It does not currently build from source repositories, manage custom application domains, or replace a production orchestration platform.

**HalfCloud: your servers, zero complexity.**
