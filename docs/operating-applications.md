# Operating applications

HalfCloud treats each application as one managed Docker container. It can create, inspect, start, stop, restart, reconfigure, and delete containers carrying the `halfcloud.managed=true` label.

## Container images

HalfCloud deploys images available to Docker, such as Docker Hub images or images from another registry that the rootless daemon can access. It does not currently clone a Git repository or build application source.

Prefer explicit version tags for important services:

```text
Deploy myorg/api:1.4.2. It listens on port 3000.
```

Using `latest` is convenient but makes later recreation less predictable because the tag can point to a different image.

## Public and private services

A public web application has a localhost-only host port in the `10000-19999` range. Caddy is the only public entry point and forwards HTTPS traffic to that port.

A private service has no published port. Containers on the `halfcloud` network reach it through `<container-name>:<internal-port>`. Keep databases, caches, queues, and workers private unless external access is explicitly required.

Published UDP ports can be created, but Caddy routes only HTTP traffic over the first published TCP port. HalfCloud 0.1 is primarily designed for HTTP applications.

## Persistent storage

Container filesystems are ephemeral. Data that must survive container recreation needs managed storage.

HalfCloud supports two forms:

- **Named volumes** are the default for databases, uploads, application state, and persistent caches. Their names follow `halfcloud-<application>-<local-name>`.
- **Managed bind directories** live beneath `/home/halfcloudrunner/.halfcloud/apps/<application>/`. Use these when files intentionally need to be visible in the host filesystem, such as editable configuration.

Both forms restrict what the AI can mount. It cannot mount arbitrary host paths. HalfCloud initializes newly created managed bind directories for images that declare a non-root user, and ownership repair is available with explicit approval when storage permissions still need correction.

Deleting an application removes its container but deliberately leaves its image and managed named volumes. This protects persistent data from an accidental application deletion. Deleting an orphaned volume is a separate destructive action and requires confirmation.

## Environment variables

Use the **Environment** action on an application to add, edit, or delete variables. New variables are protected from AI by default. The value remains visible to the administrator in this interface because this version stores environment values in plaintext.

For non-sensitive configuration, you can also ask HalfCloud to set a variable:

```text
Set LOG_LEVEL=debug on example-api and restart it.
```

Changing a variable recreates the container while preserving its managed storage, ports, image, labels, health check, and restart policy. If the application was running, the replacement is started before the old container is removed. The values are also written to the application's `.env` file with mode `0600`.

**Protect from AI** is intended for passwords, API keys, tokens, credentials, and other sensitive configuration. The agent sees a protected variable's name and that it is configured, but HalfCloud omits its value from structured agent tools and container inspection. When the agent needs a credential, it requests a dedicated form whose value goes directly to the environment API rather than through chat.

Protection from AI is not encryption at rest. Environment variables remain visible to processes in their container and to the HalfCloud control plane. Recent logs are scrubbed for exact environment values of at least four characters, but applications can log transformed or otherwise unrecognized values. The guarantee is that HalfCloud does not intentionally expose protected values through agent APIs and structured service data, not that a value can never appear in application output.

## Lifecycle actions

- **Start** starts an existing stopped container.
- **Stop** gives the container up to 10 seconds to stop gracefully.
- **Restart** performs a Docker restart with the same grace period.
- **Delete** removes the container after confirmation but preserves images and named volumes.

Managed containers use the Docker restart policy `unless-stopped`, so they normally return after a daemon or server restart unless they were intentionally stopped.

## Logs and metrics

The dashboard displays:

- host CPU, memory, disk use, and uptime;
- application state and published ports;
- per-container CPU and memory use;
- up to 200 recent log lines through the direct dashboard action.

The AI can request up to 1,000 recent lines. Docker uses rotating JSON logs capped at three 10 MB files per container.

HalfCloud reports current state; it does not currently provide historical metrics, alerting, log shipping, or automatic backups.

## Application-to-application networking

All managed applications join the `halfcloud` bridge network and resolve one another by container name. Configure clients with the private service name, not `localhost`:

```text
DATABASE_HOST=postgres
DATABASE_PORT=5432
```

Inside an application container, `localhost` means that same container. It does not refer to another HalfCloud application or the VPS host.

## Approvals

The conversational interface asks for explicit approval before it can:

- delete an application container;
- permanently delete a managed named volume;
- recursively repair ownership on mounted storage.

Review the target shown in the approval card. Approval confirms the exact pending tool call, not a general permission for future operations.

## Operational limits

HalfCloud 0.1 does not provide multi-container application definitions, rolling deployments, replicas, cluster scheduling, image registry login in the UI, shell access, arbitrary Docker options, or per-container CPU and memory limits. It is intentionally optimized for straightforward services on one server.
