# HalfCloud capabilities

HalfCloud operates containerized Apps on one VPS. You describe an outcome in chat, and its AI operator uses a fixed set of validated actions to deploy and manage the App. The dashboard provides direct controls for common day-to-day tasks.

An **App** is the primary unit in HalfCloud. It contains one or more **Services**. A Service is normally implemented by one Docker container, but users generally work with the App rather than the container.

## What HalfCloud can do

### Deploy Apps and Services

- Create a single-service App from an existing container image.
- Clone, inspect, build, and deploy a public HTTPS Git repository.
- Create a multi-service App, such as WordPress with MySQL.
- Add a database, cache, queue, worker, or other Service to an existing App.
- Give every App an immutable internal ID and a separately editable display name.
- Use official or accessible public images and persistent named volumes.
- Publish web Services at automatically generated HTTPS addresses.
- Keep supporting Services private without host port mappings.

For example, `Deploy WordPress with MySQL` creates one App named **WordPress** with `wordpress` and `mysql` Services. `Add Redis to WordPress` adds `redis` to that same App.

### Isolate private networking

- Create one private Docker bridge network per App.
- Give each Service a stable private DNS name within its App.
- Allow `web` to reach `mysql:3306` when both belong to the same App.
- Prevent Services in different Apps from reaching one another by default.

Cross-App private networking is not currently supported.

### Manage domains and access

- Attach multiple domains to an App, each targeting a specific public Service.
- Show whether each domain's DNS and HTTPS are ready.
- Keep the generated `nip.io` address as a fallback.
- Choose the primary public address.
- Protect each domain independently with HTTP Basic Auth.
- Change credentials or make a protected domain public again.

Domain changes and password setup begin in chat. Passwords are entered in a dedicated dashboard form rather than in the AI conversation, and only an Argon2id hash is stored.

### Operate Apps and Services

- List Apps with aggregate status, CPU, memory, and Service counts.
- Start, stop, restart, recreate, rename, and delete an entire App.
- Start, stop, restart, recreate, inspect, or remove an individual Service when needed.
- Read combined App logs with Service prefixes or inspect one Service's logs.
- Inspect host CPU, memory, disk use, and uptime.
- Diagnose common failures through the AI operator using the same bounded tools.

Renaming an App changes only its HalfCloud display name. It does not rename or recreate containers, networks, volumes, domains, directories, or Service identifiers.

### Manage configuration and data

- Group environment variables by Service within an App.
- Add, rename, edit, reveal, protect, and delete Service environment variables.
- Collect credentials through a dedicated form so their values do not enter the AI conversation.
- Preserve named volumes and managed bind data when a Service is recreated.
- Delete an App while retaining persistent data by default.
- Explicitly request deletion of persistent App data when that is intended.
- Inspect managed storage, delete a volume with approval, and repair mounted-storage ownership with approval.

### Maintain HalfCloud itself

- Install the control plane, rootless Docker, Caddy, and their services on a fresh Ubuntu VPS.
- Update the control plane with a short service restart while deployed Apps continue running.
- Roll back the control-plane release automatically when its post-update health check fails.

## How actions are controlled

The AI does not receive a terminal, SSH access, or a general Docker API. It can use only HalfCloud's built-in tools, whose inputs are validated by the server. Selected high-impact operations pause for approval, including deleting an App, removing a Service, deleting a volume, repairing storage ownership, and removing route password protection.

See [Why is it safe?](why-is-it-safe.md) for the complete security model and its limitations.

## What HalfCloud does not do yet

HalfCloud 0.1 is intended for Apps on one dedicated server. It does not currently:

- authenticate to private Git repositories or automatically deploy new commits;
- move a Service between Apps;
- connect Services across Apps through private networking;
- provide shared databases across Apps;
- provide replicas, rolling deployments, clusters, or multi-node scheduling;
- automatically update an App when a mutable image tag changes;
- manage DNS records;
- provide arbitrary public TCP or UDP ingress beyond Caddy-managed HTTP routes;
- provide users, roles, MFA, SSO, or advanced access policies;
- provide automatic backups, historical monitoring, alerts, or log shipping;
- enforce per-App CPU, memory, or disk quotas.

HalfCloud is under active development and is not recommended for production workloads yet.

For workflows and examples, continue with [Getting started](getting-started.md) and [Operating Apps](operating-applications.md).
