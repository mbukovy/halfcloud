<h1 align="center">HalfCloud
  <p align="center">
    <img src="frontend/public/halfcloud-logo-ui.png" width="192" alt="HalfCloud logo">
  </p>
</h1>

Open-source, AI-operated platform that makes deploying and running web apps on your own server as simple as using a managed cloud.

> **HalfCloud is under active development. It is not ready for production apps yet.**

# HalfCloud

**Vibe coding made building software dramatically easier. DevOps should follow the same path.**

Today, you can describe an app in plain English and have AI help you build it in minutes. But the moment you want to run that app on your own server, the old complexity comes back: Docker, reverse proxies, TLS, environment variables, databases, logs, networking, deployments, updates.

HalfCloud brings the same AI-first experience to infrastructure.

It is an open-source, AI-operated platform for deploying and running web applications and services on your own servers. Instead of learning infrastructure tooling or clicking through endless dashboards, you simply tell HalfCloud what you want:

- **“Deploy this GitHub repo”**
- **“Run n8n”**
- **“Deploy the best free alternative to Notion”**
- **“Put this app behind a password”**
- **“Connect my domain”**

HalfCloud figures out the rest.

You keep the flexibility and economics of your own infrastructure, without turning every project into a DevOps project.

## Why HalfCloud?

|                              | ☁️ Hyperscalers         | ▲ Vercel / Render          | 🟠 HalfCloud                                                 |
| ---------------------------- | ----------------------- | -------------------------- | ------------------------------------------------------------ |
| **Promise**                  | Maximum power           | Maximum convenience        | **Both, without the lock-in**                                |
| **Your infrastructure**      | ❌                       | ❌                          | ✅                                                            |
| **Deploy experience**        | 😵 Complex              | 🙂 Easy                    | ✨ **Easy**                                                   |
| **Run databases & services** | ✅                       | ⚠️ Limited / opinionated   | ✅ **Anything Docker can run**                                |
| **Operational model**        | DevOps team             | Managed platform           | 🤖 **AI-operated**                                           |
| **Control**                  | ✅ High                  | ⚠️ Limited                 | ✅ **High**                                                   |
| **Vendor lock-in**           | 🔒 High                 | 🔒 High                    | 🔓 **Low**                                                   |
| **Cost at scale**            | 💸 Complex              | 💸💸 Expensive             | 💰 **Just your server**                                      |
| **Open source**              | ❌                       | ❌                          | ✅                                                            |
| **Best for**                 | Enterprises with DevOps | Apps that fit the platform | **Anyone who wants their own cloud without becoming DevOps** |


**Your servers. Zero complexity.**

## Hosting that speaks your language

You should not need to become a DevOps engineer just to share something you built.

HalfCloud gives you one simple place to:

- launch apps and services;
- group web processes, databases, workers, queues, and caches into one App;
- give them a public web address;
- attach custom domains and password-protect individual addresses;
- keep their data between restarts;
- see whether they are running;
- check server health and app logs;
- fix common problems through conversation.

There are no configuration files to memorize and no maze of cloud dashboards. Describe the result you want and HalfCloud works out the steps.

## Install

For HalfCloud 0.1, start with a new Ubuntu 22.04 or newer VPS that is not being used for anything else. Choose an amd64 or arm64 server with a public IPv4 address, and make sure web traffic on ports 80 and 443 is allowed.

Connect to the server with SSH and run:

```bash
curl -fsSL https://raw.githubusercontent.com/mbukovy/halfcloud/main/install.sh | sudo bash
```

When installation finishes, it prints:

- a secure web address for your HalfCloud dashboard;
- an access code used to sign in.

Open the address, enter the code, connect your AI provider, and tell HalfCloud what you want to run.

> Before using a server that contains anything important, read [Install, uninstall, and update](docs/install-uninstall-update.md). The current uninstaller permanently removes HalfCloud, its applications, and its server data.

## Learn more

- [What HalfCloud can do](docs/capabilities.md)
- [Getting started](docs/getting-started.md)
- [How HalfCloud works](docs/how-it-works.md)
- [Why HalfCloud is safer than giving AI full server access](docs/why-is-it-safe.md)
- [Operating your applications](docs/operating-applications.md)
- [Install, update, and uninstall](docs/install-uninstall-update.md)
- [Troubleshooting](docs/troubleshooting.md)
- [All documentation](docs/README.md)
