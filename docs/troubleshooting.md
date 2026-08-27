# Troubleshooting

Start by identifying which layer is failing: public DNS and HTTPS, Caddy, the HalfCloud service, rootless Docker, an application container, or Azure OpenAI.

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
- the managed `halfcloud` network exists with incompatible labels or driver;
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

## An application returns 502

A 502 normally means Caddy has a route but cannot receive a valid response from the application's localhost port. Check:

- whether the container is still running;
- the application's recent logs;
- whether the image actually listens on the internal port used at deployment;
- whether the process listens on `0.0.0.0` inside the container rather than only its own `127.0.0.1`;
- whether startup requires missing environment variables or persistent storage permissions.

Ask HalfCloud:

```text
Why is <application> returning 502? Check its status and recent logs.
```

If needed, inspect containers directly as the runtime user:

```bash
sudo -u halfcloudrunner docker ps -a
sudo -u halfcloudrunner docker logs --tail 200 <application>
```

## An application cannot reach a database

Use the database container name and internal port, for example `postgres:5432`. Do not use `localhost` from another container. Both services must be attached to the `halfcloud` network.

Also check credentials, database initialization logs, and whether the client starts before the database is ready. HalfCloud does not currently create dependency health ordering between containers.

## A port is already in use

Published ports must be in `10000-19999`. HalfCloud checks both Docker bindings and other localhost processes before creation. It will report the conflict and suggest an available port.

Do not stop an unrelated service merely to use a preferred internal number. The host port can differ from the application's internal port; Caddy hides that implementation detail from public users.

## Persistent storage has permission errors

Confirm the image's expected data path and declared runtime user. Mounting storage at the wrong path can appear to work while data remains ephemeral.

HalfCloud can repair ownership only for storage already mounted by the selected managed application. The repair recursively changes ownership and may briefly stop a running container, so it requires explicit approval. Do not use `chmod 777` as a generic fix.

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

Then search within `less` using `/chat:<request-id>`. Server logs may contain application names, endpoint addresses, model errors, and stack traces. API-key redaction is best effort, so handle logs as sensitive data.

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
- container image and tag;
- expected and actual behavior.

Remove access codes, API keys, environment values, domain secrets, and private application data before sharing logs.
