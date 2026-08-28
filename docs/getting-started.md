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

## Deploy the first App

Ask for the outcome in ordinary language:

```text
Run nginx for me.
```

HalfCloud inspects current Apps and ports, chooses the image and normal web port, creates an App containing one Service, and configures its Caddy route. The AI then inspects the App status and recent logs. A public App normally receives a URL like:

```text
https://nginx.<public-ip>.nip.io
```

The dashboard shows the App without a redundant nested Service row when it has only one Service. It includes status, CPU and memory use, routes, logs, environment configuration, and lifecycle controls. On smaller screens, use the tabs to switch between the operator, Apps, and server status.

## Useful first requests

```text
How is this server doing?
```

```text
Show all running Apps.
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

Do not paste secrets into chat. Chat content is sent to the configured AI provider. When a Service needs a credential, HalfCloud presents a dedicated environment-variable form that submits the value directly to the server instead.

## Deploy a multi-service App

Databases, queues, and other dependencies usually belong to the same App as the Service that uses them and should not be exposed to the internet:

```text
Deploy WordPress with MySQL. Keep MySQL private and persist its data.
```

HalfCloud creates one **WordPress** App with `wordpress` and `mysql` Services. Both join the App's private network, where WordPress can use `mysql:3306`. MySQL receives no public hostname or host port. Other Apps cannot reach it by default.

You can extend the App later:

```text
Add Redis to WordPress.
```

Redis is added as another Service in WordPress rather than appearing as a separate App.

## Use a custom domain

Create an `A` record pointing the hostname to the VPS public IPv4 address, then ask HalfCloud to add that hostname to the App. In a multi-service App, name the target Service when it is not obvious. The generated `nip.io` address remains available as a fallback, and the first custom hostname becomes the primary public URL. Caddy obtains and renews certificates after public DNS resolves and ports 80 and 443 can reach the server.

HalfCloud does not manage DNS records. The default `nip.io` names work without a DNS account because the server IP is embedded in the hostname.

Adding and removing domains is chat-driven. The dashboard shows every route's DNS, HTTPS, primary, fallback, and access state, and lets you open a route or make it primary.

## Password-protect a route

Protection applies to one hostname, not automatically to every hostname attached to the App. Ask HalfCloud:

```text
Password-protect admin.example.com.
```

After that hostname has working DNS and HTTPS, HalfCloud presents a dedicated form for its username and password. Enter the credentials there, not in chat. The password goes directly to the local HalfCloud API, is hashed with Argon2id by Caddy, and is not recoverable afterward.

Ask HalfCloud to change the credentials when needed. You can also ask it to remove protection; because that makes the route public, the change requires approval. HTTP Basic Auth provides one credential pair per route and is intended as a simple access gate, not as a replacement for application accounts, roles, MFA, or SSO.

## Next steps

- Read [Operating Apps](operating-applications.md) before deploying stateful software.
- See [HalfCloud capabilities](capabilities.md) for the current product scope and limitations.
- Read [Why is it safe?](why-is-it-safe.md) to understand the trust model and remaining risks.
- Keep [Troubleshooting](troubleshooting.md) available for host-level diagnostics.
