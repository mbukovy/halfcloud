# Install, uninstall, and update

HalfCloud 0.1 is designed for a fresh VPS dedicated to HalfCloud. Read this page before running any lifecycle script as root.

## Requirements

The installer requires:

- Ubuntu 22.04 or newer;
- an amd64 (`x86_64`) or arm64 (`aarch64`) server;
- systemd;
- a public IPv4 address detectable from the server;
- inbound TCP ports 80 and 443 open in the provider firewall and host firewall;
- outbound HTTPS access for packages, source archives, container images, certificates, and Azure requests;
- no active host Docker socket at `/var/run/docker.sock`.

A small VPS can run HalfCloud, but actual CPU, memory, and disk requirements depend on the applications. Leave enough disk space for image layers, volumes, logs, dependency installation, and one staged update build.

Do not install version 0.1 on a server that already contains Docker workloads, Caddy configuration, Node.js state, or data you cannot lose. The installation and especially uninstallation model assumes a dedicated machine.

## Install

Run from a normal sudo-capable account:

```bash
curl -fsSL https://raw.githubusercontent.com/mbukovy/halfcloud/main/install.sh | sudo bash
```

Running a remote script as root trusts the current `main` branch. To inspect it first:

```bash
curl -fsSL https://raw.githubusercontent.com/mbukovy/halfcloud/main/install.sh -o install.sh
less install.sh
sudo bash install.sh
```

The installer:

1. validates the operating system, architecture, systemd, root privileges, and absence of an active host Docker daemon;
2. installs prerequisite packages;
3. creates the unprivileged `halfcloudrunner` account and subordinate ID ranges;
4. installs and starts rootless Docker for that account;
5. installs Node.js 22 when needed;
6. downloads, builds, and prunes the HalfCloud application;
7. creates private configuration, data, application, log, and secret directories;
8. detects the public IPv4 address and creates `nip.io` hostnames;
9. generates an access code and session secret;
10. installs `halfcloud.service` with systemd hardening;
11. installs Caddy and configures HTTPS;
12. tests rootless localhost port publication, API health, runtime identity, and public HTTPS.

At completion it prints the control-plane URL and access code. Store the access code securely.

## If installation fails

Read the final error before rerunning the installer. Common causes are an unsupported OS, an existing Docker socket, blocked outbound traffic, missing public IPv4, or closed ports 80 and 443.

The installer is not a transactional package manager. A failure can leave packages, users, repositories, or services partially configured. Diagnose the cause before choosing whether to rerun it or use the uninstaller. Do not use the uninstaller on a mixed-purpose server because it removes host-wide Docker, Caddy, and Node.js components.

See [Troubleshooting](troubleshooting.md) for diagnostics.

## Update

Update an installed and healthy control plane to the current `main` branch with:

```bash
curl -fsSL https://raw.githubusercontent.com/mbukovy/halfcloud/main/update.sh | sudo bash
```

The updater requires `halfcloud.service` to be running. It takes a non-blocking host lock so two updates cannot run concurrently.

The new release is downloaded, dependencies are installed, and assets are built before the current service is stopped. During the final swap:

- only the HalfCloud control plane is restarted;
- Caddy, rootless Docker, and application containers stay running;
- `/home/halfcloudrunner/.halfcloud` and rootless Docker data are preserved;
- the previous application release is retained temporarily;
- the local health endpoint is checked for up to about 60 seconds.

If the health check fails after the release swap, the updater restores and starts the previous release. A successful update deletes that temporary release backup.

Updates currently track a moving branch rather than a versioned release channel. Review changes before updating a server that matters.

## Back up before lifecycle changes

HalfCloud does not create backups. Back up stateful applications using their native tools, such as a database dump, and verify restoration.

For a broad filesystem backup, account for both:

- `/home/halfcloudrunner/.halfcloud`, which contains configuration, credentials, managed bind data, and environment files;
- the rootless Docker data directory, normally `/home/halfcloudrunner/.local/share/docker`, which contains named volumes, images, containers, and Docker metadata.

Copying live database files or a live Docker data directory may produce an inconsistent backup. Stop or quiesce the relevant application, or use an application-aware backup process. Protect backups because they can contain API keys, passwords, and application data.

## Uninstall

Uninstallation is intentionally destructive. It permanently removes:

- every HalfCloud application container, image, named volume, bind directory, log, and credential;
- the `halfcloudrunner` account and its entire home directory;
- HalfCloud and Caddy services and configuration;
- host Docker and containerd state;
- Docker, Caddy, Node.js, and related package-repository configuration installed for HalfCloud.

It can therefore destroy unrelated data if those host-wide components were later reused for something else.

Run the uninstaller from a sudo-capable account other than `halfcloudrunner`:

```bash
curl -fsSL https://raw.githubusercontent.com/mbukovy/halfcloud/main/uninstall.sh | sudo bash
```

An interactive terminal is required. The script displays the deletion scope and proceeds only after this exact confirmation:

```text
UNINSTALL HALFCLOUD
```

The operation cannot be undone. Back up and verify everything you need before confirming. Shared prerequisite packages that may be used by other software are left installed, but the listed Docker, Caddy, and Node.js packages are purged.

## Service commands

Useful host-level commands after installation are:

```bash
systemctl status halfcloud caddy
journalctl -u halfcloud
journalctl -u halfcloud -f
sudo -u halfcloudrunner docker info
```

Because Docker is rootless, commands run as root against the default host Docker socket inspect the wrong daemon or fail. Use the `halfcloudrunner` identity when diagnosing HalfCloud containers.
