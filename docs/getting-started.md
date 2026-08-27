# Getting started

This guide begins after the [installation](install-uninstall-update.md) has completed successfully.

## Sign in

The installer prints two values:

```text
https://halfcloud.<public-ip>.nip.io

Access code:
XXXXXX-XXXXXX
```

Open the URL and enter the access code. The code is stored on the server at `/home/halfcloudrunner/.halfcloud/secrets/access-code`; it is not recoverable from the web interface.

A successful sign-in creates a secure, HTTP-only, same-site session cookie valid for 30 days. Use **Sign out** when using a shared browser.

## Connect Azure OpenAI

HalfCloud currently requires an Azure-hosted model with tool-calling support. In **AI settings**, provide:

- **Endpoint:** the HTTPS endpoint for your Azure OpenAI resource or Azure AI Foundry deployment;
- **API key:** the corresponding API key;
- **Deployment / model:** the deployment name configured in Azure.

For a conventional Azure OpenAI resource, the endpoint normally looks like:

```text
https://<resource-name>.openai.azure.com
```

Do not include a deployment path in that URL. HalfCloud also accepts supported `*.services.ai.azure.com` endpoints and normalizes their OpenAI API path.

Credentials are sent to the HalfCloud server and stored locally in `/home/halfcloudrunner/.halfcloud/data/settings.json`. The API key is not returned to the browser after it is saved. Requests made through chat send the conversation and relevant tool results to the configured Azure service, subject to that service's data handling policy.

## Deploy the first application

Ask for the outcome in ordinary language:

```text
Run nginx for me.
```

HalfCloud will inspect current applications and ports, select the image and normal web port, create the container, configure a hostname, update Caddy, and check its status and logs. A public application normally receives a URL like:

```text
https://nginx.<public-ip>.nip.io
```

The dashboard shows the container state, image, published ports, CPU and memory use, URL, logs, and lifecycle controls.

## Useful first requests

```text
How is this server doing?
```

```text
Show all running applications.
```

```text
Show the last 100 log lines for nginx.
```

```text
Restart nginx.
```

For software that needs configuration, include what you know:

```text
Run myorg/example-api:1.4. It listens on port 3000 and needs NODE_ENV=production.
```

Do not paste secrets into a request unless they are required as application environment variables. Chat content is sent to the configured AI provider.

## Deploy a private dependency

Databases, queues, and other dependencies usually should not be exposed to the internet:

```text
Run PostgreSQL 17 for my application. Keep it private and persist its data.
```

Every managed container joins the private `halfcloud` Docker network. Other applications can reach a service by its container name and internal port, for example `postgres:5432`. A private-only container has no public hostname or host port.

## Use a custom domain

Create an `A` record pointing the hostname to the VPS public IPv4 address, then ask HalfCloud to use that exact hostname when deploying the application. Caddy obtains and renews the TLS certificate after public DNS resolves and ports 80 and 443 can reach the server.

HalfCloud does not manage DNS records. The default `nip.io` names work without a DNS account because the server IP is embedded in the hostname.

## Next steps

- Read [Operating applications](operating-applications.md) before deploying stateful software.
- Read [Why is it safe?](why-is-it-safe.md) to understand the trust model and remaining risks.
- Keep [Troubleshooting](troubleshooting.md) available for host-level diagnostics.
