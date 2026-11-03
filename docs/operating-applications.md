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

New Services are staged in a stopped state. HalfCloud configures their complete first-run environment, including values entered through protected credential prompts, before starting them. This prevents databases and other initialization-sensitive images from saving incomplete credentials to persistent storage.

To extend an existing App:

```text
Add Redis to WordPress.
```

The new `redis` Service joins WordPress's existing private network. Service names are stable private DNS names within the App.

To run another instance of an existing Service, ask HalfCloud to copy it (for example, "Copy worker as worker-2 in Customer API"). The copy gets the same image and all environment variables, including protected values, without revealing credentials to the agent. It starts stopped so you can adjust its settings before starting it. By default it is private; request a distinct public port if it needs its own public address. Copies share the source's managed bind mounts and named volumes, so web and worker Services can use the same files. This is not a data copy: both Services write to the same storage. Only start copies when the application supports concurrent access; do not scale databases or other single-writer Services this way. Mounts outside the managed App and unmanaged volumes remain blocked.

## Running commands in chat

Ask HalfCloud to run a command in a running Service, for example:

```text
Run node --version in the web Service of Customer API and show the output.
```

The command runs inside the existing container using its configured user and working directory. Chat shows the combined standard output and errors, plus the exit code, even when the command fails. Output is limited to 32 KiB and configured environment values are redacted. Commands are non-interactive; shell syntax requires a shell available in the image.

HalfCloud waits up to 60 seconds by default, or up to five minutes when requested. If the wait times out or you cancel the chat, the command may continue running; disconnecting does not stop the Service or kill the command. Required initialization for stopped Services uses the separate temporary-container setup tool.

## Images and names

HalfCloud deploys images available to the rootless Docker daemon, public HTTPS Git repositories, and private GitHub repositories. For a private repository, HalfCloud generates a dedicated read-only SSH deploy key and gives you the exact GitHub settings link. The private key never leaves the server. Git-backed Apps use a persistent HalfCloud-managed checkout, but their runtime still uses built images and the same managed Service primitives as image-based Apps.

Prefer explicit version tags for important Services:

```text
Deploy myorg/api:1.4.2 as Customer API. It listens on port 3000.
```

Using `latest` is convenient but makes later recreation less predictable because the tag can point to a different image.

An App has an immutable internal ID and an editable display name. Renaming **Customer API** to **Acme API** changes only what HalfCloud displays. It does not rename or recreate runtime resources. Service names are operational identifiers and are not exposed as simple cosmetic renames.

## Updating Git Apps

```text
Deploy latest changes from git for Customer API.
```

The first verified deployment saves a dedicated `Dockerfile.update`, ignore rules, build context, image identity, and health path for **each repository-built Service**, outside the Git checkout. Services may use different Dockerfiles and images. These saved recipes are not regenerated during an update.

Copying a verified repository-built Service also copies its update recipe. Once the new Service is started, manual and GitHub push updates build and replace both instances along with every other repository-built Service in the App. A Service without a verified recipe cannot be copied until its deployment is verified.

Adding a repository-built Service requires starting it and verifying the Git deployment again before automatic updates can include it. Replacing a running Service with a build at the already verified commit updates its saved recipe after readiness checks; replacing it with a build at a new commit requires App-wide verification. Removing a Service also removes its saved recipe. Image-based supporting Services do not need Git update recipes.

During preparation, `verifyGitDeployment` accepts `serviceHealthPaths` keyed by Service ID or name, so multiple APIs can each save their own readiness endpoint. Docker health-check startup timing is respected within a bounded five-minute readiness window.

An update is one deterministic backend operation, not an AI deployment conversation. HalfCloud fetches the configured branch once and builds each Service from the latest source and its saved recipe in an isolated build context. All candidate images are built before any running container is stopped. Supporting databases and caches are left alone. The App and Service identities, domains and route protection, environment values, and persistent storage are retained. Blue/green deployment allocates new local host ports; recreate deployment preserves existing port mappings.

HalfCloud checks the actual image identity, running/health status, and saved HTTP/HTTPS readiness path repeatedly before accepting the update. If a build fails, the running App is untouched. If replacement or readiness fails, all replaced Services are restored from retained containers. A durable App-wide decision lets server startup finish a committed update or roll back an interrupted one. It does not automatically rewrite a failing Dockerfile or retry builds indefinitely.

Existing environment values take precedence over defaults in the new image. If an update requires changing one of those values, configure it explicitly rather than relying on a changed Dockerfile `ENV` default.

Each Service uses its saved deployment strategy. Existing recipes default to `recreate`, which briefly stops the Service during replacement. HTTP Services can use `blue-green` for a healthy traffic cutover. Updates require the existing Services to be running. Container rollback does not undo writes to shared storage or databases. The updater runs saved pre-deploy migration commands; one-time initialization and new configuration changes require explicit preparation. Saved recipes give a fixed procedure, not bit-for-bit reproducible output: pin base-image digests and dependency versions where reproducibility is required.

### Zero-downtime HTTP deployments

Ask HalfCloud to enable zero-downtime deployment for a verified web/API Service. `configureServiceDeploymentStrategy` saves `strategy: "blue-green"` in its update recipe. Set `strategy: "recreate"` to restore stop/start replacement. Both strategies work with manual, API, CLI and GitHub push updates, and verification preserves the choice.

For blue/green Services, the updater:

1. Builds every candidate image, then creates stopped candidates on spare loopback ports while old containers continue serving.
2. Runs saved pre-start migration commands with the candidate image and existing environment/storage.
3. Starts candidates, checks their Docker health and readiness endpoint directly, then enables Service network aliases and rechecks readiness.
4. Switches all ready HTTP routes for the App in **one atomic Caddy configuration load**, preserving domains and authentication. Concurrent route edits retain the old targets until this cutover.
5. Checks public readiness, durably commits the update, drains old traffic, then gracefully stops and removes old containers.

Old containers remain available until cutover succeeds. If migration, health or proxy loading fails, HalfCloud restores the previous proxy targets **before** removing candidates. A lost proxy response is treated as a possibly applied cutover. If routing cannot be restored, both generations and the recovery journal are retained. Restart recovery reconciles traffic before container cleanup; it never reruns migrations.

The default drain period is 30 seconds. `HALFCLOUD_DEPLOY_DRAIN_MS` configures 0–300000 milliseconds, followed by Docker's ten-second graceful stop. Caddy delays closing streaming connections on configuration reload. Requests and WebSockets lasting beyond the drain/stop window may still need to reconnect.

Blue/green requires room to run both versions, HTTP readiness, and application/storage support for overlapping instances. Database migrations must be backward-compatible with the old version. Keep workers and single-writer Services on `recreate`. Atomic switching covers HTTP traffic through HalfCloud's domains; direct host-port clients and private Docker DNS are not an atomic App-wide cutover. Local ports change between generations. A private copy of a public Service uses `recreate`.

### Automatic database migrations

After verifying a Service's deployment, ask HalfCloud to save its recurring migration command, for example `npm run db:migrate`. The approval-gated `configureServiceUpdateCommand` tool saves `["npm", "run", "db:migrate"]` in that Service's recipe. Approval covers future updates; GitHub pushes do not require another chat or prompt. Use `command: null` to remove a saved command.

Manual, API, CLI and GitHub push updates all build every candidate image first, then run saved commands sequentially before starting candidate application processes or switching traffic. Blue/green candidates are created stopped before these commands. Each command runs in a disposable container using the **new immutable image**, its user and working directory, the Service's complete environment and existing mounts, and the private App network. Existing environment values override new image defaults. There are no published ports, shell expansion or returned command logs, and execution is bounded to five minutes.

The old application and supporting databases remain running during migration. Use repeatable, backward-compatible migrations, and assign the command to one migration-owner Service. Copying a Service copies its build recipe but omits this command to avoid duplicating migrations. Verification and subsequent updates preserve a configured command.

A failed migration prevents image replacement and is reported as an initialization failure. Later readiness failures restore previous containers, but database and storage writes remain. Interrupted-update recovery restores containers without replaying commands and records that data may have changed. Migration runners should track applied migrations so an explicitly requested later update can resume safely.

Apps created before recipe persistence need one explicit preparation/build and verified deployment before deterministic updates are available. HalfCloud refuses to guess a missing recipe or recreate the App. Existing local checkout conflicts also fail safely. Restart and Recreate alone do not fetch or build Git changes.

### Updating without AI

The authenticated `POST /api/apps/:appId/update` endpoint runs exactly the same updater, even when no AI provider is configured. Send an empty JSON object and an authenticated HalfCloud session. The response reports the deployed commit, changed Services, or that the App is already current. The request waits for completion; closing the client does not cancel the server-owned update.

From an installed checkout after building HalfCloud:

```bash
npm run update:app -- "Customer API"
```

Set `HALFCLOUD_ACCESS_CODE` through your process environment or secret manager. Optionally set `HALFCLOUD_URL` to the HTTPS control-plane address; the default is `http://127.0.0.1:9000`. The CLI authenticates and calls the API, never invokes an LLM, and exits nonzero on failure. Scheduling this command is possible, but push-triggered deployment is not enabled automatically.

### GitHub push deployments

```text
Automatically update Customer API when I push to GitHub.
```

HalfCloud opens a trusted setup widget for the App's existing GitHub repository and configured branch. The App must already have a verified deployment with saved per-Service update recipes. Public repositories and private GitHub repositories are supported; the webhook does not change repository access or require a GitHub API token.

1. Open the GitHub Webhooks settings link in the widget and choose **Add webhook**.
2. Copy the HTTPS **Payload URL** from the widget. It points to HalfCloud's control-plane hostname, not an application domain.
3. Select content type **application/json**. Copy the generated **Secret** directly from the widget into GitHub; never paste it into chat.
4. Select **Just the push event**, leave **SSL verification** enabled, keep **Active** checked, and save.
5. GitHub sends a signed ping. Use **Check connection** in the widget, then **Enable automatic updates** after verification succeeds.

Future matching pushes run the same deterministic updater without an AI request. HalfCloud validates the raw delivery's HMAC-SHA256 signature, repository identity, and exact branch. Tags, branch deletions, and other branches do not deploy. A ping verifies the connection but never deploys. Signing secrets are kept in a private backend store, separate from App environment values, and are never included in agent tool results, conversation history, or debug exports.

Accepted pushes are durably queued before GitHub receives a response. Bursts are coalesced, one automatic build runs at a time, and a push arriving during an update leaves one follow-up update. Manual repository operations defer queued work rather than dropping it. Each execution fetches the latest configured branch, not the historical commit from an old delivery. Delivery IDs and signed-body hashes are deduplicated for up to seven days, bounded to the latest 128 admissions per App; this is not permanent exactly-once delivery.

Ask to show the App's GitHub webhook setup again to check recent delivery/update outcomes, disable automatic updates, or rotate the secret. Disabling clears queued work but lets an active rollout finish safely. Rotation generates a new payload URL and secret, disables updates, and requires updating both fields in GitHub and verifying again. Deleting an App removes its local integration; remove the obsolete webhook from GitHub too.

Startup performs deployment recovery before processing pending webhook work. A previously started webhook attempt is marked interrupted rather than blindly rerun; independently queued pushes remain eligible. Build or health failures are shown in the widget and App status, without an automatic AI repair loop. The same restart, migration, storage, and rollback limitations as manual updates apply.

The control-plane hostname in `HALFCLOUD_HOSTNAME` must be reachable from GitHub over HTTPS. The signed receiver is `POST /api/webhooks/github/:hookId`; setup and secret endpoints remain session-authenticated. JSON deliveries are bounded to 25 MiB and compressed bodies are rejected. Authentication uses the signature, never a URL token or a browser session in place of that signature. Other webhook-triggered operations are not supported.

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

Hostname redirects are independent of Apps and Services. Ask HalfCloud to redirect one hostname to another and it creates a native Caddy permanent redirect to HTTPS, preserving the request path and query string. The source hostname still needs DNS pointed at the HalfCloud server so Caddy can obtain its certificate.

Removing protection makes the selected hostname public and requires explicit approval. Other routes in the App are unaffected. Basic Auth is a simple access gate, not a replacement for application accounts, roles, MFA, or SSO.

## Persistent storage

Container filesystems are ephemeral. Data that must survive Service recreation needs managed storage.

For an existing Service, ask HalfCloud to add persistent storage for its application data directory. The approved `addServiceStorage` action stops the Service, copies that directory (including files in the original container's writable layer) into a new named volume, and recreates the same Service with its settings and existing storage preserved. A previously stopped Service remains stopped. If copying or recreation fails, the original container is restored and the new volume is retained for inspection. Existing volume names and paths overlapping existing mounts are refused to avoid overwriting data.

Add persistence **before** changing environment variables or deploying another image, because those operations recreate the container and discard unmounted writable-layer files. During explicit Git deployment preparation, configure required directory variables after adding storage, then run documented approved migrations. Ordinary Git updates reuse existing storage and run only their saved pre-deploy commands.

HalfCloud supports:

- **Named volumes** for databases, uploads, application state, and persistent caches.
- **Managed bind directories** beneath the App's ID-based HalfCloud directory when files intentionally need host filesystem access.

Storage belongs to an App and is attached to a specific Service. Generated volumes carry App and Service ownership labels. Runtime volume and directory names use immutable IDs rather than the App display name, so an App rename does not affect storage.

HalfCloud restricts what the AI can mount. It cannot mount arbitrary host paths. It initializes newly created managed bind directories for images that declare a non-root user, and ownership repair is available with explicit approval.

Ask HalfCloud to read a specific text file in mounted storage, for example, "Read `config/settings.json` from the web Service's `/data` mount." The `readStorageFile` tool supports managed bind directories and named volumes, including volumes shared within the App. It works while the Service is stopped and needs no approval: an isolated helper mounts only the selected storage read-only, without App environment variables or network access. The first read downloads the `node:22-alpine` helper image if needed. Reads return up to 16 KiB by default (64 KiB maximum), with file size and truncation status. Traversal, symlinks, non-regular files, non-UTF-8 content, and sensitive paths such as `.env` and private keys are rejected; configured environment values are redacted from the returned text.

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

## One-shot Service initialization

Some software requires a non-interactive setup, migration, seed, repair, or administrative command before its normal process can run. HalfCloud can run such a command for any managed Service, including a stopped Service deployed directly from an image.

The command runs as a disposable container with the Service's exact image, environment, user, working directory, and persistent mounts. By default it joins the private App network, which supports stopped Services and access to dependencies by Service name. When a documented administrative CLI must reach a running Service through `localhost`, HalfCloud can instead share that Service's network namespace. Neither mode publishes additional ports or starts, stops, or replaces the original Service. HalfCloud removes the disposable container after completion and withholds its output so configured credentials are not copied into the AI conversation.

This is not an interactive shell. The command is a bounded argument list selected for a documented operation, and the signed-in user must approve the exact request. It can still modify the Service's persistent data and contact dependencies on the App network. If the normal Service is running, stop it first when the operation requires exclusive access to shared storage.

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
- run a one-shot command with a Service's credentials, persistent storage, and private network access.

Review the target and data-retention choice shown in the approval card. Approval confirms the exact pending tool call, not a general permission for future operations.

## Operational limits

HalfCloud 0.1 does not provide Service moves between Apps, cross-App private networking, replicas, rolling deployments, cluster scheduling, image registry login in the UI, interactive shell access, arbitrary Docker options, or per-Service resource limits. It pulls an image only when it is absent locally, so a mutable tag such as `latest` is not an automatic update mechanism.
