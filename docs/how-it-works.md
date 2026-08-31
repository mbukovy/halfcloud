# How it works

HalfCloud is a small control plane over established infrastructure: Linux, rootless Docker, Caddy, and an Azure-hosted language model.

## Request path

```text
Browser
   |
   | HTTPS :443
   v
Caddy (host system service)
   |
   | 127.0.0.1:9000
   v
HalfCloud (system service as halfcloudrunner)
   |
   | /run/user/<uid>/docker.sock
   v
Rootless Docker
   |
   v
Apps
  └─ Service containers
```

Caddy listens publicly on ports 80 and 443. The HalfCloud Node.js process listens only on `127.0.0.1:9000`, and public Service ports listen only on `127.0.0.1:10000-19999`.

## The control plane

The host service runs the built frontend and backend from `/home/halfcloudrunner/halfcloud`. Its systemd unit starts as the unprivileged `halfcloudrunner` account and connects only to that account's rootless Docker socket.

The backend provides:

- access-code authentication and browser sessions;
- Azure OpenAI configuration and streamed chat;
- a fixed collection of App- and Service-management tools;
- App metadata plus Service status, logs, and metrics;
- validation of Service names, ports, mounts, volumes, and hostnames;
- generation and loading of Caddy routes.

HalfCloud verifies at startup that the Docker daemon reports rootless mode and reconstructs routes from Service ownership labels plus persisted domain state.

## What happens during a chat request

1. The browser sends the conversation to the local HalfCloud API.
2. HalfCloud sends the messages and its tool definitions to the configured Azure model.
3. The model chooses a tool such as listing Apps, creating a multi-service App, adding a Service, or reading logs.
4. HalfCloud validates the structured tool arguments before executing code against rootless Docker.
5. Tool results return to the model so it can verify the operation and explain the outcome.
6. Selected destructive, ownership-changing, or exposure-increasing tools pause for approval in the browser before execution.

The model never receives a general shell tool. Docker operations are implemented in application code and reject requests outside the supported policy.

Environment management has separate administrator and agent representations. The authenticated Environment API can return raw values to the dashboard. Agent tools use an explicit serializer that entirely omits `value` for protected variables, and the controlled container-inspection tool never forwards raw Docker `Config.Env`. A credential requested in chat is submitted from its dedicated widget directly to the Environment API.

Route-password setup follows a similar split. The agent requests a credential form for a stable route ID, but the browser submits the password directly to the local API. Caddy hashes it with Argon2id, and HalfCloud persists only the hash. The username and completion status may return to the conversation; the password and hash do not.

## App creation

When creating an App, HalfCloud:

1. creates an immutable App ID and stores the display name separately;
2. creates a private bridge network owned by that App;
3. validates every Service image, name, environment key, hostname, storage request, and port;
4. creates immutable Service IDs and ID-based runtime names;
5. creates managed directories and named volumes with App and Service ownership labels;
6. pulls missing images and creates rootless containers with constrained Docker options;
7. attaches every Service to the App network with its Service name as a private DNS alias;
8. binds only public Service ports to localhost and starts the Services;
9. regenerates Caddy routes and returns the complete App state for verification.

Service containers receive a `no-new-privileges` security option, a 512-process limit, rotating logs, and an `unless-stopped` restart policy. Apps do not share private networks.

Containers, networks, and volumes carry `halfcloud.managed=true` plus App and Service ownership labels where applicable. Runtime resource names are derived from immutable IDs, so editing an App display name does not recreate or rename infrastructure.

## HTTPS and domains

The installer detects the public IPv4 address and sets the base domain to `<ip>.nip.io`. The control plane uses `halfcloud.<ip>.nip.io`; public Apps receive a generated hostname derived from the App name.

Caddy's admin API listens on `127.0.0.1:2019`. HalfCloud sends it a complete generated Caddyfile whenever managed App state changes. Only running Services with a hostname and published TCP port receive a route.

Caddy obtains and renews public certificates. Domains belong logically to an App and route to a specific Service. The generated `nip.io` hostname remains attached when a custom hostname is added. A custom hostname works when its DNS points to the VPS and the server is reachable on ports 80 and 443.

Each public Service's domain state stores stable route IDs, hostnames, primary status, and access configuration. A route can independently use Caddy HTTP Basic Auth with one username and Argon2id password hash. Stopped Services are omitted from Caddy's generated configuration.

## Data locations

| Path | Purpose |
|---|---|
| `/home/halfcloudrunner/halfcloud` | Installed application release |
| `/home/halfcloudrunner/.halfcloud/config/service.env` | Runtime configuration and session secret |
| `/home/halfcloudrunner/.halfcloud/secrets/access-code` | Sign-in access code |
| `/home/halfcloudrunner/.halfcloud/data/settings.json` | Azure endpoint, deployment, and API key |
| `/home/halfcloudrunner/.halfcloud/data/apps.json` | Immutable App IDs, display names, and App timestamps |
| `/home/halfcloudrunner/.halfcloud/apps/<app-id>` | App-owned managed bind data and runtime environment file |
| `/home/halfcloudrunner/.halfcloud/apps/<service-id>` | Service environment metadata, domain state, and trusted-input request metadata |
| `/home/halfcloudrunner/.halfcloud/repositories/<app-id>/repository` | Persistent deployment-source checkout for a Git-backed App |
| `/home/halfcloudrunner/.local/share/docker` | Rootless Docker images, containers, named volumes, and metadata |
| `/etc/systemd/system/halfcloud.service` | Host systemd service definition |
| `/etc/caddy/Caddyfile` | Initial Caddy configuration; runtime configuration is loaded through the local admin API |

The exact rootless Docker data path is controlled by Docker and can vary if its configuration changes. Back up App data with Service-aware tools or include the complete `halfcloudrunner` home directory rather than assuming everything lives under `.halfcloud`.

## Updates

The updater downloads and builds a new release in a staging directory while the current control plane remains online. It then stops only `halfcloud.service`, swaps the release directory, starts the new version, and checks `/api/health`.

Docker, Caddy, and App Services continue running during the swap. If the new control plane does not become healthy, the updater restores and starts the previous release automatically. See [Install, uninstall, and update](install-uninstall-update.md) for the complete procedure.
