# Why is it safe?

The short answer is that HalfCloud is designed to be safer than giving an AI agent an unrestricted root shell. It reduces privileges, narrows available operations, validates every deployment, and asks for approval before selected destructive actions.

It does not make arbitrary containers, language models, or an internet-facing server inherently safe. HalfCloud 0.1 is an early preview and should not be used for production workloads.

## No root at runtime

The installer runs as root because it must install packages, create accounts, and register services. The HalfCloud control plane itself runs as the dedicated `halfcloudrunner` user, which is not added to the `sudo` or `docker` groups.

Its systemd service also applies:

- `NoNewPrivileges=true`;
- private temporary and device namespaces;
- a read-only view of the host home and system paths;
- write access limited to `/home/halfcloudrunner/.halfcloud`;
- restrictions on set-user-ID and set-group-ID transitions.

The separate Caddy service retains the host privileges needed to accept public traffic. Its admin endpoint is bound to localhost.

## Rootless Docker

HalfCloud installs a Docker daemon owned by `halfcloudrunner`. The daemon socket is `/run/user/<uid>/docker.sock`, not `/var/run/docker.sock`, and HalfCloud refuses to start against a socket that does not belong to its process user or does not report rootless mode.

Rootless Docker runs the daemon and containers without host root privileges and maps container identities through subordinate user and group IDs. This substantially reduces the effect of many container escapes and daemon compromises, but it is still a security boundary implemented by the Linux kernel and container runtime, not a guarantee against every vulnerability.

## The AI has tools, not a terminal

The model can call only operations defined by HalfCloud. There is no shell, arbitrary Docker API proxy, file browser, or SSH tool.

The deployment API rejects:

- privileged containers;
- host networking;
- host devices;
- Docker socket mounts;
- arbitrary host bind mounts;
- published ports outside `10000-19999`;
- non-localhost published port bindings;
- operations on containers or volumes without HalfCloud management labels.

Managed bind paths must remain inside the selected application's directory. Named volumes must carry matching HalfCloud labels before they can be reused or modified.

These checks are code-enforced. They do not depend only on asking the language model to behave.

## Destructive actions require approval

Deleting an application, deleting a managed volume, and recursively changing storage ownership pause until the signed-in user approves the exact tool call. If approval is dismissed, the operation is not executed.

Application deletion preserves named volumes and images by default. Volume deletion is separate because it destroys persistent data.

Approval is an important last check, but it is not protection if an attacker already controls an authenticated browser session or if a user approves a misleading request without reviewing it.

## Network exposure is narrow by default

Only Caddy is intended to accept public application traffic. The control plane and application host ports bind to `127.0.0.1`. Databases and other private services can run without any published port and communicate over the `halfcloud` Docker network.

HTTPS is automatic, and the control-plane route adds HSTS, MIME-sniffing protection, frame denial, and a same-origin referrer policy. State-changing API requests require JSON and reject cross-site origins. Session cookies are HTTP-only, secure in production, and `SameSite=Strict`.

## Authentication and credentials

The installer generates a random access code and a separate random session-signing secret. Access-code comparison is timing-safe. Eight failed attempts from one observed client IP trigger a 15-minute in-memory delay.

Azure credentials are stored on the VPS in a mode-`0600` file and are not returned through the settings API. Error handling and container-log display attempt to redact API keys and environment values.

Application environment variables can be marked **Protect from AI**, which is enabled by default in the dashboard and credential-request widget. Agent-facing environment data is explicitly serialized: protected entries contain their name and configuration status but no `value` property. Docker still receives the real value, and administrators can view it in the authenticated Environment interface. This is an AI-disclosure boundary, not encryption at rest or a secrets vault.

Important limitations:

- HalfCloud currently has one shared administrator access code, not named users, roles, MFA, or revocable sessions.
- Login throttling is in memory and resets when the service restarts.
- A session cookie remains valid for up to 30 days unless it expires or the signing secret changes.
- Root or the `halfcloudrunner` account can read stored credentials and application data.
- Log redaction is best effort and cannot recognize every secret or transformed value.
- If a user puts a credential in normal chat or an application writes it into logs, the AI may receive it. Use the dedicated protected environment input instead of chat for credentials.

Protect the access code as an administrator credential. Restrict network access further with a firewall, VPN, or trusted reverse proxy when appropriate.

## Container-level controls

Created applications use `no-new-privileges`, a process limit of 512, rootless networking, localhost-only publication, and bounded log rotation. Images cannot request extra privileges through HalfCloud.

HalfCloud does not currently enforce CPU, memory, or disk quotas. A buggy or malicious image may exhaust server resources, attack other services on the shared private network, send outbound traffic, or exploit a kernel or runtime vulnerability. Only run images you trust, use immutable tags or digests where practical, and keep the host updated.

## AI and prompt-injection risk

The model sees user messages, tool results, and potentially application logs. Untrusted text in logs or application output may attempt to manipulate the model. The fixed tool boundary limits what such manipulation can achieve, while approval gates protect selected high-impact actions, but prompt injection is not solved in general.

Review proposed operations, especially changes involving secrets, storage, or deletion. Chat content is sent to the configured Azure endpoint, so do not submit information that provider should not process.

## Installation and update trust

The documented commands download scripts from the repository's `main` branch and run them as root. The installer also uses upstream package repositories and Docker's installation script. This is convenient but means installation trusts the current repository, GitHub delivery, and those upstream sources.

For a higher-assurance environment, inspect the scripts before running them and pin a reviewed commit instead of executing the moving `main` branch. HalfCloud 0.1 does not yet publish signed, versioned release artifacts.

## Security model summary

HalfCloud aims to make the safe path the easy path:

- an unprivileged runtime instead of root;
- rootless containers instead of the host daemon;
- structured and validated operations instead of shell access;
- private networking instead of publishing every service;
- explicit approval for selected destructive operations;
- standard infrastructure that an administrator can still inspect directly.

These controls reduce risk and blast radius. They do not replace host patching, backups, trusted images, firewalling, credential hygiene, monitoring, or careful review of AI-initiated operations.
