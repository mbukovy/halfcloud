# HalfCloud documentation

HalfCloud operates containerized Apps on a dedicated VPS through a conversational interface. An App can contain one or more Services, while containers remain a runtime detail. These guides explain the current 0.1 release in more detail than the project [README](../README.md).

## Start here

- [HalfCloud capabilities](capabilities.md) is a concise overview of what the product can and cannot do today.
- [Getting started](getting-started.md) covers the first sign-in, Azure OpenAI configuration, and first deployment.
- [Operating Apps](operating-applications.md) explains Services, private networking, domains, storage, environment variables, lifecycle actions, and observability.
- [Install, uninstall, and update](install-uninstall-update.md) documents requirements, exactly what the scripts change, updates, backups, and destructive removal.

## Understand the system

- [How it works](how-it-works.md) describes the control plane, rootless Docker, networking, Caddy routing, and data locations.
- [Why is it safe?](why-is-it-safe.md) documents security boundaries, approval gates, authentication, and the risks those controls do not remove.

## Solve a problem

- [Troubleshooting](troubleshooting.md) provides health checks, logs, common failure modes, and recovery guidance.

## Current scope

HalfCloud 0.1:

- supports Ubuntu 22.04 or newer on amd64 and arm64;
- is intended for a fresh, dedicated VPS;
- deploys existing container images and public HTTPS Git repositories;
- groups one or more Services into each App and isolates Apps on separate private networks;
- manages public HTTPS routes, custom domains, and optional per-domain password protection;
- uses Azure OpenAI or an Azure AI Foundry-compatible endpoint;
- manages one server and one rootless Docker daemon;
- is under active development and is not recommended for production workloads.

The source code is the final authority when documentation and behavior differ. Please report discrepancies while the project is evolving.
