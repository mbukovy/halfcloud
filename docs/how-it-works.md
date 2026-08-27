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
Managed application containers
```

Caddy listens publicly on ports 80 and 443. The HalfCloud Node.js process listens only on `127.0.0.1:9000`, and application ports listen only on `127.0.0.1:10000-19999`.

## The control plane

The host service runs the built frontend and backend from `/home/halfcloudrunner/halfcloud`. Its systemd unit starts as the unprivileged `halfcloudrunner` account and connects only to that account's rootless Docker socket.

The backend provides:

- access-code authentication and browser sessions;
- Azure OpenAI configuration and streamed chat;
- a fixed collection of application-management tools;
- container status, logs, and metrics;
- validation of container names, ports, mounts, volumes, and hostnames;
- generation and loading of Caddy routes.

HalfCloud verifies at startup that the Docker daemon reports rootless mode. It also reconnects managed containers to the shared network and reconstructs routes from current container labels.

## What happens during a chat request

1. The browser sends the conversation to the local HalfCloud API.
2. HalfCloud sends the messages and its tool definitions to the configured Azure model.
3. The model chooses a tool such as listing containers, creating an application, or reading logs.
4. HalfCloud validates the structured tool arguments before executing code against rootless Docker.
5. Tool results return to the model so it can verify the operation and explain the outcome.
6. Destructive or ownership-changing tools pause for approval in the browser before execution.

The model never receives a general shell tool. Docker operations are implemented in application code and reject requests outside the supported policy.

## Application creation

For a typical public application, HalfCloud:

1. validates the name, image, environment keys, hostname, storage, and requested ports;
2. ensures the managed `halfcloud` network exists;
3. rejects name or port conflicts and suggests another available port;
4. creates managed directories and named volumes;
5. pulls the image if it is not already available;
6. creates a rootless container with constrained Docker options;
7. binds its port to localhost and starts it;
8. regenerates Caddy routes from managed container labels;
9. inspects status and recent logs to verify the deployment.

Containers receive a `no-new-privileges` security option, a 512-process limit, rotating logs, and an `unless-stopped` restart policy. All application containers share the managed bridge network.

## HTTPS and domains

The installer detects the public IPv4 address and sets the base domain to `<ip>.nip.io`. The control plane uses `halfcloud.<ip>.nip.io`; applications default to `<application>.<ip>.nip.io`.

Caddy's admin API listens on `127.0.0.1:2019`. HalfCloud sends it a complete generated Caddyfile whenever managed application state changes. Only running containers with a hostname and a published TCP port receive a route.

Caddy obtains and renews public certificates. A custom hostname works when its DNS already points to the VPS and the server is reachable on ports 80 and 443.

## Data locations

| Path | Purpose |
|---|---|
| `/home/halfcloudrunner/halfcloud` | Installed application release |
| `/home/halfcloudrunner/.halfcloud/config/service.env` | Runtime configuration and session secret |
| `/home/halfcloudrunner/.halfcloud/secrets/access-code` | Sign-in access code |
| `/home/halfcloudrunner/.halfcloud/data/settings.json` | Azure endpoint, deployment, and API key |
| `/home/halfcloudrunner/.halfcloud/apps/<name>` | Per-application environment file and managed bind data |
| `/home/halfcloudrunner/.local/share/docker` | Rootless Docker images, containers, named volumes, and metadata |
| `/etc/systemd/system/halfcloud.service` | Host systemd service definition |
| `/etc/caddy/Caddyfile` | Initial Caddy configuration; runtime configuration is loaded through the local admin API |

The exact rootless Docker data path is controlled by Docker and can vary if its configuration changes. Back up application data at the application level or include the complete `halfcloudrunner` home directory rather than assuming everything lives under `.halfcloud`.

## Updates

The updater downloads and builds a new release in a staging directory while the current control plane remains online. It then stops only `halfcloud.service`, swaps the release directory, starts the new version, and checks `/api/health`.

Docker, Caddy, and application containers continue running during the swap. If the new control plane does not become healthy, the updater restores and starts the previous release automatically. See [Install, uninstall, and update](install-uninstall-update.md) for the complete procedure.
