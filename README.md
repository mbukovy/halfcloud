# HalfCloud

> **Under active development. Do not use HalfCloud for production workloads yet.**

**Your servers. Zero complexity.**

HalfCloud is an open-source, self-hosted platform for deploying and operating web applications on your own server through a simple AI conversation.

You describe the outcome:

> Run n8n for me.

> Add this environment variable and restart the service.

> Why is my API returning 502?

> Which service is using all the memory?

HalfCloud handles containers, networking, HTTPS, persistent storage, logs, and routine operations behind the conversation. No Kubernetes, no proprietary runtime, and no unrestricted AI shell.

## From container to cloud

Building software has become fast. Getting it online still means dealing with servers, reverse proxies, certificates, ports, logs, and databases.

HalfCloud is built for that last mile:

```text
Your container image
        |
        v
    HalfCloud
        |
        v
    Your VPS
        |
        v
https://your-app.example.com
```

Bring a VPS and standard container images. HalfCloud turns them into running applications while keeping the infrastructure on a server you control.

## One server, everything your app needs

A single VPS can run more than a frontend. HalfCloud is designed for web applications, APIs, databases, workers, automation tools, internal services, and experiments that unexpectedly found users.

```text
Your VPS

|-- Web app
|-- API
|-- PostgreSQL
|-- Redis
|-- Background worker
`-- Whatever comes next
```

Public applications receive HTTPS through Caddy. Private services stay on an internal Docker network. Your applications remain standard containers, so the underlying stack stays portable and understandable.

## AI with boundaries

Giving an AI agent root access to a server is not a deployment strategy.

HalfCloud gives the model a small set of validated operations instead of a terminal. It can deploy and manage HalfCloud applications, inspect status and logs, and diagnose common failures. It cannot request privileged containers, host networking, host devices, arbitrary host mounts, or access to the host Docker socket.

The result is AI for convenience, containers for portability, and guardrails that reduce the blast radius when something goes wrong.

## Install

HalfCloud 0.1 requires a fresh, dedicated Ubuntu 22.04 or newer VPS with a public IPv4 address. Ports 80 and 443 must be open. An active host Docker daemon causes installation to stop.

```bash
curl -fsSL https://raw.githubusercontent.com/mbukovy/halfcloud/main/install.sh | sudo bash
```

Open the HTTPS URL printed by the installer, sign in with the generated access code, and connect your Azure OpenAI deployment.

Read [Install, uninstall, and update](docs/install-uninstall-update.md) before installing, especially if the server already contains data or software you need to keep.

## Documentation

- [Documentation overview](docs/README.md)
- [Getting started](docs/getting-started.md)
- [Operating applications](docs/operating-applications.md)
- [How it works](docs/how-it-works.md)
- [Why is it safe?](docs/why-is-it-safe.md)
- [Install, uninstall, and update](docs/install-uninstall-update.md)
- [Troubleshooting](docs/troubleshooting.md)

HalfCloud is currently an early preview. Its capabilities and installation model may change before the first stable release.
