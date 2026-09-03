<h1 align="center">HalfCloud
  <p align="center">
    <img src="frontend/public/halfcloud-logo-ui.png" width="192" alt="HalfCloud logo">
  </p>
</h1>

Open-source, AI-operated platform that makes deploying and running web apps on your own server as simple as using a managed cloud.

> **HalfCloud is under active development. It is not ready for production apps yet.**

## DevOps should be as easy as vibe coding

Vibe coding made building software dramatically easier. DevOps should follow the same path.

Today, you can describe an app in plain English and have AI help you build it in minutes. But the moment you want to run that app on your own server, the old complexity comes back: Docker, reverse proxies, TLS, environment variables, databases, logs, networking, deployments, updates.

HalfCloud brings the same AI-first experience to infrastructure.

It is an open-source, AI-operated platform for deploying and running web applications and services on your own servers. Instead of learning infrastructure tooling or clicking through endless dashboards, you simply tell HalfCloud what you want:

- `Deploy this GitHub repo`
- `Run n8n`
- `Deploy the best free alternative to Notion`
- `Put this app behind a password`
- `Connect my domain`

HalfCloud figures out the rest.

You keep the flexibility and economics of your own infrastructure, without turning every project into a DevOps project.

## AI-powered deployment costs pennies

Running an AI agent doesn't have to make hosting expensive.

HalfCloud gives the model purpose-built infrastructure tools, so even small, inexpensive models can perform real deployment work without needing an expensive frontier model for every task.

Here are real HalfCloud deployment runs using **GPT-5.6 Luna**:

| Deployment | What HalfCloud was asked | AI inference cost |
| --- | --- | ---: |
| **n8n** | `run n8n` | **$0.005** |
| **WordPress** | `run wordpress` | **$0.009** |
| **Element Plus Vite Starter** | Deploy a public GitHub repository | **$0.024** |

That's roughly **half a cent to deploy n8n**, **less than one cent for WordPress**, and **a few cents to inspect, build and deploy a GitHub application**.

These are measured AI inference costs from actual HalfCloud runs, not the cost of the VPS or other infrastructure.

> **The model doesn't need to know everything about DevOps. HalfCloud gives it the tools to do the work.**

The exact cost depends on the model, provider, prompt caching and complexity of the deployment. The point is not that every deployment costs exactly one cent — it's that capable AI infrastructure operations can already be **cheap enough to be practically negligible compared with the server itself**.
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

## Just tell HalfCloud what you want

HalfCloud is built around one idea: infrastructure should be operated by intent, not by configuration files and dashboards.

Tell it what you want to run:

* `Run n8n`
* `Deploy WordPress`
* `Deploy https://github.com/element-plus/element-plus-vite-starter`
* `Add PostgreSQL to my app`
* `Put this app behind a password`
* `Connect example.com`
* `Show me why this app is failing`
* `Restart the app`
* `Update it to the latest version`

HalfCloud turns those requests into real infrastructure changes on your server.

It can inspect repositories, build applications, run supporting services, configure networking and HTTPS, manage environment variables, inspect logs, and operate existing apps — while keeping the underlying infrastructure on your own machine.

### See it in action

<!-- Demo video / GIF goes here -->

## Install

For HalfCloud 0.9, start with a new Ubuntu 22.04 or newer VPS that is not being used for anything else. Choose an amd64 or arm64 server with a public IPv4 address, and make sure web traffic on ports 80 and 443 is allowed.

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

## FAQ

#### What do I need to run HalfCloud?
A fresh Ubuntu 22.04+ VPS with:
* a public IPv4 address;
* ports 80 and 443 open;
* amd64 or arm64 CPU;
* enough RAM and disk for the apps you want to run.

You can get a small VPS from providers like **Contabo, Hostinger, IONOS, Hetzner, DigitalOcean**, and many others.
For simple apps, plans often start at around **$5–$6/month**.
A small VPS is enough to try HalfCloud.
#### Which AI model should I use?
You do not need the most expensive model.
For most deployments, a small model with good coding and tool-use capabilities is enough.
We currently recommend **GPT-5.6 Luna** as a great default. In our tests, it can deploy real apps while costing only a few cents per operation.
For harder debugging or unusual projects, you can switch to a stronger model.
#### Do I have to use OpenAI?
No.
HalfCloud supports multiple AI providers. Pick the provider and model you prefer.
#### How much does the AI cost?
Usually cents.
In real HalfCloud tests using GPT-5.6 Luna:
* n8n deployment: about **$0.005**
* WordPress deployment: about **$0.009**
* GitHub app deployment: about **$0.024**
The exact price depends on the model and what HalfCloud has to do.
#### Does AI have full access to my server?
No.
The AI does not get an unrestricted SSH shell.
Instead, it works through tools provided by HalfCloud. Those tools define what the AI can inspect and change.
#### Does my data leave the server?
HalfCloud itself runs on your server.
When AI is needed, the information required for that task may be sent to the AI provider you configured.
HalfCloud is designed to avoid sending secrets and unnecessary server data to the model.
#### Can the AI read my passwords and secrets?
HalfCloud can keep sensitive environment variables hidden from the AI.
If the model does not need a secret to complete a task, it should not see it.
Anything you type directly into the chat should still be treated as information that may be sent to your AI provider.
#### Is it safe?
HalfCloud is designed to be much safer than giving an AI agent unrestricted SSH access to your server.
The model works through a limited set of HalfCloud tools instead of running arbitrary commands directly.
That said, HalfCloud is still under active development and is not recommended for important production systems yet.
#### Is HalfCloud a hosting provider?
No.
You bring your own server.
HalfCloud runs on it and helps you deploy and manage your apps.
#### What if I stop using HalfCloud?
Your apps still run on your server.
HalfCloud is only the management layer. Your infrastructure and data remain yours.

## Where HalfCloud is going

HalfCloud is built by [Michal Bukovy](https://www.linkedin.com/in/mbukovy/) — a developer who has spent far too much of the last 15 years dealing with DevOps.
The goal is simple: **make running applications on your own infrastructure feel as easy as using a managed platform — without giving up control, flexibility, or cost efficiency.**
HalfCloud is still early, but the direction is clear.

### Coming next

* **Notifications and outgoing webhooks**
  Know when deployments succeed, fail, or need your attention — or forward those events to tools like n8n and build your own workflows.

* **Webhook-triggered actions**
  Let external tools trigger HalfCloud actions through simple webhooks — deploy, restart, rollback, investigate a problem with AI, or run other operations. Sensitive actions can require human confirmation before anything changes.

* **Development and production environments**
  Run separate environments for the same application and move a tested version to production with a simple **Promote to production** action.

* **Branch deployments**
  Deploy a specific Git branch into its own environment for testing, previews, or experiments.

* **Disposable test environments**
  Quickly create an isolated environment, try something, and remove it when you are done.

### Longer-term vision

Today, HalfCloud manages applications running on a single server.
Eventually, it should be able to treat **multiple VPS servers as one simple pool of infrastructure**.
Add another inexpensive VPS and HalfCloud could decide where applications should run based on available CPU, memory, storage, and workload.
From there, the same philosophy can extend to:

* moving workloads between servers
* shared or replicated storage
* simple load balancing
* redundancy and failover
* better resource utilization across multiple machines
* scaling applications beyond a single VPS

The important part is what should **not** change:
**No Kubernetes degree required. No cloud architecture certification. No weeks of DevOps setup.**
You add servers. You deploy applications. HalfCloud handles the complexity underneath.
