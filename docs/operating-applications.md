# Operating Apps

HalfCloud treats an **App** as one deployable application or system. Every App contains one or more **Services**, and each Service normally runs as one rootless Docker container.

The dashboard collapses a single-service App into one compact view. Multi-service Apps show their Services as components, such as `web`, `worker`, `mysql`, and `redis`. Container IDs and runtime names remain implementation details.

## Creating Apps

Ask for the desired outcome:

```text
Deploy n8n.
```

HalfCloud creates an `n8n` App containing one `n8n` Service.

```text
Deploy WordPress with MySQL.
```

HalfCloud creates one **WordPress** App containing `wordpress` and `mysql` Services. It does not create a separate database App.

To extend an existing App:

```text
Add Redis to WordPress.
```

The new `redis` Service joins WordPress's existing private network. Service names are stable private DNS names within the App.

## Images and names

HalfCloud deploys images available to the rootless Docker daemon. It does not currently clone a Git repository or build application source.

Prefer explicit version tags for important Services:

```text
Deploy myorg/api:1.4.2 as Customer API. It listens on port 3000.
```

Using `latest` is convenient but makes later recreation less predictable because the tag can point to a different image.

An App has an immutable internal ID and an editable display name. Renaming **Customer API** to **Acme API** changes only what HalfCloud displays. It does not rename or recreate runtime resources. Service names are operational identifiers and are not exposed as simple cosmetic renames.

## Private networking

Each App receives its own private Docker bridge network. Services in that App resolve one another by Service name:

```text
DATABASE_HOST=mysql
DATABASE_PORT=3306
REDIS_URL=redis://redis:6379
```

Inside a Service, `localhost` means that same Service. Use the target Service name to connect to another component in the App.

Two different Apps may both contain a Service called `postgres` without conflict because their networks are isolated. Services in different Apps cannot communicate over private networking by default. Cross-App networking is not currently supported.

## Public Services and domains

A public web Service has a localhost-only host port in the `10000-19999` range. Caddy is the public entry point and forwards HTTPS traffic to that Service. Databases, caches, queues, and workers normally have no host port.

Domains belong logically to the App and route to a specific Service. For a single-service App, HalfCloud selects the only Service automatically. For a multi-service App, commands can name the target:

```text
Add api.example.com to the api Service in MyApp.
```

The generated `nip.io` hostname remains as a fallback. The first custom domain becomes primary, and the dashboard can make any attached route primary. HalfCloud reports DNS, HTTPS, primary, fallback, and access state for each route.

Each hostname can independently be public or protected with HTTP Basic Auth. Ask HalfCloud to protect a route or change its credentials, then enter the username and password in the dedicated form rather than chat. Password protection requires working DNS and HTTPS. Caddy stores an Argon2id password hash; the plaintext password cannot be recovered.

Removing protection makes the selected hostname public and requires explicit approval. Other routes in the App are unaffected. Basic Auth is a simple access gate, not a replacement for application accounts, roles, MFA, or SSO.

## Persistent storage

Container filesystems are ephemeral. Data that must survive Service recreation needs managed storage.

HalfCloud supports:

- **Named volumes** for databases, uploads, application state, and persistent caches.
- **Managed bind directories** beneath the App's ID-based HalfCloud directory when files intentionally need host filesystem access.

Storage belongs to an App and is attached to a specific Service. Generated volumes carry App and Service ownership labels. Runtime volume and directory names use immutable IDs rather than the App display name, so an App rename does not affect storage.

HalfCloud restricts what the AI can mount. It cannot mount arbitrary host paths. It initializes newly created managed bind directories for images that declare a non-root user, and ownership repair is available with explicit approval.

Deleting an App removes its Services, private network, active routes, and registry entry. Persistent named volumes and managed bind data are retained by default. Deleting persistent data requires an explicit request and approval. Images are not removed automatically.

## Environment variables

Environment variables belong to individual Services. In a multi-service App, configure the intended Service rather than assuming a variable applies to every component.

Use the **Environment** action on a Service to add, rename, edit, reveal, protect, or delete variables. Variables added in the dashboard or a credential-request widget are protected from AI by default. Values supplied in normal chat have already been exposed to the configured model and are not retroactively protected.

For non-sensitive configuration, you can ask HalfCloud:

```text
Set LOG_LEVEL=debug on the api Service in MyApp.
```

Saving variable changes recreates only that Service while preserving its managed storage, ports, image, labels, health check, private-network alias, and restart policy. This causes a brief interruption; it is not a rolling update.

**Protect from AI** is intended for passwords, API keys, tokens, and other sensitive values. Agent-facing data contains a protected variable's name and configuration status but not its value. Protection is an AI-disclosure boundary, not encryption at rest or a secrets vault.

Recent logs are scrubbed for exact environment values of at least four characters, but applications can log transformed or otherwise unrecognized values. Do not treat log redaction as a complete secret-scanning system.

## Lifecycle actions

App-level actions normally affect every Service:

- **Start** starts stopped Services.
- **Stop** gives running Services up to 10 seconds to stop gracefully.
- **Restart** restarts every Service.
- **Recreate** rebuilds runtime containers while retaining managed volumes.
- **Delete** removes runtime resources while retaining persistent data by default.

Advanced commands can target one Service:

```text
Restart only mysql in Company Website.
Show logs from the worker in MyApp.
Recreate the web Service in MyApp.
```

Managed Services use Docker's `unless-stopped` restart policy, so they normally return after a daemon or server restart unless intentionally stopped.

## Status, logs, and metrics

App status is derived from its Services. The dashboard reports whether the App is running, partially running, stopped, degraded, or failed and shows how many Services are running.

App CPU and memory values are sums of current Service metrics. Multi-service Apps also show each Service's current state. Host CPU, memory, disk use, and uptime remain visible separately.

App-level logs combine output from all Services and prefix each line with its Service name:

```text
[web] Server started on port 3000
[worker] Processing job 493
[mysql] Ready for connections
```

You can request one Service's logs when debugging. The dashboard supports 200, 500, or 1,000 recent lines, text filtering, reverse ordering, and manual refresh. Docker uses rotating JSON logs capped at three 10 MB files per Service.

HalfCloud reports current state; it does not currently provide historical metrics, alerting, log shipping, or automatic backups.

## Approvals

The conversational interface asks for explicit approval before it can:

- delete an App;
- remove a Service from an App;
- permanently delete managed data;
- recursively repair ownership on mounted storage;
- remove password protection from a route, making it public.

Review the target and data-retention choice shown in the approval card. Approval confirms the exact pending tool call, not a general permission for future operations.

## Operational limits

HalfCloud 0.1 does not provide Service moves between Apps, cross-App private networking, replicas, rolling deployments, cluster scheduling, image registry login in the UI, shell access, arbitrary Docker options, or per-Service resource limits. It pulls an image only when it is absent locally, so a mutable tag such as `latest` is not an automatic update mechanism.
