# Troubleshooting

Start by identifying which layer is failing: public DNS and HTTPS, Caddy, the HalfCloud control plane, an App, one of its Services, rootless Docker, or Azure OpenAI.

## Quick health check

Run these commands on the VPS:

```bash
systemctl status halfcloud caddy
curl -fsS http://127.0.0.1:9000/api/health
journalctl -u halfcloud --no-pager -n 100
sudo -u halfcloudrunner docker info
```

A healthy local API responds with:

```json
{"status":"healthy"}
```

The health endpoint also pings rootless Docker. A `503` means the Node.js service is reachable but Docker is not healthy from its perspective.

## The public URL does not open

Check each layer in order:

1. Confirm `halfcloud.service` and `caddy.service` are active.
2. Confirm the local API health request succeeds.
3. Confirm the hostname resolves to the VPS public IPv4 address.
4. Confirm the cloud-provider firewall or security group allows inbound TCP 80 and 443.
5. Confirm any host firewall allows the same ports.
6. Inspect Caddy logs with `journalctl -u caddy --no-pager -n 100`.

Certificate issuance requires public DNS and inbound connectivity. If the server IP changed, the default `<old-ip>.nip.io` hostname and generated configuration no longer match the server; version 0.1 has no automatic IP migration workflow.

A stopped public Service is intentionally omitted from Caddy's active routes. Start the App or target Service before diagnosing its hostname as a DNS or certificate problem.

## Route password protection cannot be enabled

HalfCloud enables protection only after the selected hostname passes DNS and externally validated HTTPS checks. Confirm that:

- the hostname resolves to the VPS public IPv4 address;
- inbound ports 80 and 443 are open;
- Caddy is running and has obtained a certificate;
- the target Service is running and the route is visible in its App;
- you selected the intended hostname, because protection is configured per route.

If a protected route unexpectedly returns `401 Unauthorized`, use the exact username and password entered for that hostname. Passwords cannot be recovered; ask HalfCloud to change the route credentials and use the new form. To make the route public, ask HalfCloud to remove protection and approve the operation after checking the hostname.

## HalfCloud does not start

Inspect the service and recent logs:

```bash
systemctl status halfcloud
journalctl -u halfcloud --no-pager -n 100
```

Startup deliberately fails when:

- the configured Docker socket is missing or has the wrong path;
- the socket does not belong to the runtime user;
- Docker does not report rootless mode;
- an App network exists with incompatible ownership labels or driver;
- required environment values such as the control-plane hostname are missing;
- the access-code file is empty or unreadable;
- Caddy rejects route synchronization.

Do not work around these checks by pointing HalfCloud at `/var/run/docker.sock` or adding `halfcloudrunner` to the Docker group. That removes a core safety boundary.

## Rootless Docker is unavailable

Find the runtime user ID and inspect its service:

```bash
id halfcloudrunner
systemctl status user@$(id -u halfcloudrunner).service
sudo -u halfcloudrunner docker info
```

The installer enables user lingering so rootless Docker can run without an interactive login. If the user service is stopped, inspect its logs with:

```bash
journalctl _UID=$(id -u halfcloudrunner) --no-pager -n 100
```

Avoid starting a separate host Docker daemon. HalfCloud manages its own rootless daemon and socket.

## An App returns 502

A 502 normally means Caddy has a route but cannot receive a valid response from the targeted Service's localhost-bound host port. Check:

- whether the target Service is still running;
- the App's combined logs and the target Service's logs;
- whether the image actually listens on the internal port used at deployment;
- whether the process listens on `0.0.0.0` inside the container rather than only its own `127.0.0.1`;
- whether startup requires missing environment variables or persistent storage permissions.

Ask HalfCloud:

```text
Why is <app> returning 502? Check the target Service and its recent logs.
```

If needed, inspect containers directly as the runtime user:

```bash
sudo -u halfcloudrunner docker ps -a
sudo -u halfcloudrunner docker logs --tail 200 <runtime-container-name>
```

## A Service cannot reach a database

Use the database Service name and internal port, for example `postgres:5432`. Do not use `localhost` from another Service. Both Services must belong to the same App and be attached to that App's private network.

Services in different Apps are isolated by design. Do not attach them to a global network as a workaround. Cross-App private networking is not currently supported.

Also check credentials, database initialization logs, and whether the client starts before the database is ready. HalfCloud does not currently create a dependency or health graph beyond container runtime behavior.

## A port is already in use

Published ports must be in `10000-19999`. HalfCloud checks both Docker bindings and other localhost processes before creation. It will report the conflict and suggest an available port.

Do not stop an unrelated Service merely to use a preferred internal number. The host port can differ from the Service's internal port; Caddy hides that implementation detail from public users.

## Persistent storage has permission errors

Confirm the image's expected data path and declared runtime user. Mounting storage at the wrong path can appear to work while data remains ephemeral.

HalfCloud can repair ownership only for storage already mounted by the selected managed Service. The repair recursively changes ownership and may briefly stop that Service, so it requires explicit approval. Do not use `chmod 777` as a generic fix.

## Azure chat fails

Check **AI settings** for:

- the correct HTTPS resource endpoint without an accidental deployment path;
- a valid API key;
- the exact Azure deployment name;
- a deployed model that supports the required Responses API and tool calls;
- Azure quota, regional availability, and network access.

Chat errors include a request ID and redacted provider details. Search the service log for the same ID:

```bash
journalctl -u halfcloud --no-pager | less
```

Then search within `less` using `/chat:<request-id>`. Server logs may contain App and Service names, endpoint addresses, model errors, and stack traces. API-key redaction is best effort, so handle logs as sensitive data.

## An update failed

The updater normally restores the previous release automatically when the new service fails its health check. Read both the updater output and service log:

```bash
systemctl status halfcloud
journalctl -u halfcloud --no-pager -n 100
```

If the updater stopped before swapping releases, it restarts the unchanged service. If it swapped releases and rollback also failed to start, the previous files should remain at `/home/halfcloudrunner/halfcloud`; inspect ownership, build output, service configuration, and logs before making manual changes.

## Reporting a problem

Include:

- Ubuntu version and CPU architecture;
- whether this was install, update, startup, deployment, or runtime failure;
- the exact command or natural-language request;
- relevant `halfcloud` and Caddy log lines;
- the chat request ID when present;
- App name, Service name, and image tag;
- expected and actual behavior.

Remove access codes, API keys, environment values, domain secrets, and private App data before sharing logs.
