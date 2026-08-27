# HalfCloud ☁️

**Your servers. Zero complexity.**

HalfCloud is an open-source, self-hosted platform for deploying and operating **web applications and services** on your own servers through a simple AI conversation.

You built the app. Now just tell HalfCloud to run it.

> Deploy this app and give it a domain.

> Run n8n for me.

> Add this environment variable and restart the service.

> Why is my API returning 502?

> Which service is eating all the memory?

HalfCloud handles the infrastructure behind it.

No Kubernetes. No giant control plane. No YAML archaeology. **No DevOps degree required.**

## Install

On a fresh Linux VPS, run as root:

```bash
curl -fsSL https://raw.githubusercontent.com/mbukovy/halfcloud/main/install.sh | bash
```

Open the HTTPS URL printed by the installer, sign in with your access code and connect your AI provider.

## From code to running app

Building software has changed dramatically.

You can prototype an application in an afternoon, generate 99% of the code with AI, push it to GitHub — and then suddenly find yourself configuring Cloud console or Linux servers, containers, DNS, reverse proxies and TLS certificates.

**HalfCloud is built for that last mile.**

Bring a VPS. Install HalfCloud. Tell it what you want running.

```text
Your code
   ↓
GitHub / Docker
   ↓
HalfCloud
   ↓
Your VPS
   ↓
https://your-app.com
```

Your code can move fast.

**Your infrastructure shouldn't slow it down.**

## Your server, without the server management

Running a VPS is cheap.

Operating one properly isn't.

Deployments, containers, reverse proxies, TLS certificates, environment variables, logs, networking and updates aren't particularly difficult individually.

Together, they're enough complexity to turn shipping a small web app into an infrastructure project.

HalfCloud puts an **AI operations layer** on top of your servers.

You describe the outcome.

HalfCloud handles the operations.

## Deploy without becoming a DevOps engineer

The traditional way:

```text
Rent VPS
→ SSH into server
→ install Docker
→ configure firewall
→ write compose.yaml
→ configure reverse proxy
→ configure TLS
→ start containers
→ inspect logs
→ search why you're getting 502
→ edit config
→ restart everything
→ finally ship
```

The HalfCloud way:

```text
Install HalfCloud
→ "Deploy my app"
→ ship
```

That's the idea.

## What can HalfCloud do?

- Deploy containerized web applications and services
- Start, stop, restart and remove services
- Run multiple apps on a single server
- Configure domains and reverse proxying
- Automatically handle HTTPS with Caddy
- Manage environment variables
- Inspect containers, logs and runtime state
- Monitor CPU, memory and disk usage
- Diagnose deployment and runtime problems
- Operate infrastructure through natural language

All while keeping the actual infrastructure **on your servers and under your control**.

## Built for shipping

Maybe you built your app with Claude Code, Cursor, Codex, Lovable or just a suspicious amount of caffeine.

HalfCloud doesn't care how the code was written.

**HalfCloud helps you get it online and keep it running.**

It's built for developers, indie hackers, AI builders and small teams who want to ship web applications without turning every project into an infrastructure project.

Use it to run:

- web applications
- APIs and backend services
- AI agents
- automation tools
- internal tools
- open-source software
- databases and supporting services
- side projects
- experiments that unexpectedly got users
- that AI-generated app you promised yourself was "just a prototype"

## Why your own server?

Platforms like Vercel and Render made deploying web applications dramatically easier.

They're great — until your application stops fitting neatly into their platform.

You need a database. A background worker. An AI agent that runs continuously. A custom container. Persistent storage. Another internal service.

Or you simply don't want your infrastructure bill growing with every new component.

Then the abstraction starts leaking.

HalfCloud takes the opposite approach:

**Don't abstract the server away. Make the server easy to operate.**

A single inexpensive VPS can run your web app, API, database, workers, queues, automation tools and supporting services together.

```text
Your VPS

├── Web app
├── API
├── PostgreSQL
├── Redis
├── Background worker
├── n8n
└── Whatever you need next
```

No per-service pricing. No platform-specific runtime. No artificial boundary between the things your application needs.

### Simple doesn't have to mean limited

Managed platforms optimize for a specific way of running software.

HalfCloud optimizes for **your server**.

That means you keep the flexibility to run standard containers, persistent services, databases, workers and custom software — without turning every deployment into a DevOps project.

And because you're paying for the server rather than assembling a collection of individually priced managed services, the economics can be very different too.

For many small and medium-sized applications, a **$5–20 VPS is already a surprisingly capable cloud.**

HalfCloud just makes it feel like one.

### The middle ground

HalfCloud sits between two extremes:

| | Raw VPS | Managed platforms | HalfCloud |
|---|---|---|---|
| Easy deployment | ❌ | ✅ | ✅ |
| Low infrastructure cost | ✅ | ⚠️ | ✅ |
| Run arbitrary containers | ✅ | ⚠️ | ✅ |
| Run your own database | ✅ | ⚠️ | ✅ |
| Persistent services | ✅ | ⚠️ | ✅ |
| Full server control | ✅ | ❌ | ✅ |
| AI operations | ❌ | ❌ | ✅ |
| Requires DevOps knowledge | ⚠️ | ❌ | ❌ |

**The flexibility and economics of your own server, with the experience of a modern deployment platform.**

## AI with guardrails

Giving an autonomous AI agent unrestricted SSH access to your server is... adventurous.

HalfCloud takes a different approach.

The AI operates through a deliberately limited set of infrastructure tools. It can deploy services, inspect containers, read logs, manage configuration and perform common operational tasks — without simply handing the model unrestricted root access.

**Enough power to operate your apps. Not enough power to casually destroy the server.**

## How it works

HalfCloud keeps the stack intentionally boring.

Under the hood, your applications run as **Docker containers** on your own server. **Caddy** handles routing, domains and automatic HTTPS, while HalfCloud provides the management layer and AI interface on top.

```text
You
 ↓
HalfCloud AI
 ↓
Controlled operations
 ↓
Docker + Caddy
 ↓
Your apps
```

### Why this approach?

**Your apps stay portable.**  
HalfCloud runs standard containers. You're not deploying into a proprietary runtime or inventing a new packaging format.

**Your server stays yours.**  
Applications, data and configuration live on infrastructure you control. HalfCloud is self-hosted alongside them.

**AI doesn't get a magic root terminal.**  
Instead of giving the model unrestricted shell access and hoping for the best, HalfCloud exposes a controlled set of operations for deploying, configuring, inspecting and managing services.

**The infrastructure stays understandable.**  
HalfCloud builds on tools developers already know — Linux, Docker and Caddy — rather than hiding everything behind a custom orchestration layer.

**You can always drop down a level.**  
HalfCloud is there to remove routine infrastructure work, not to lock you out of your own machine. When you need to investigate something manually, it's still just your server and your containers underneath.

The result is deliberately simple:

**AI for convenience. Containers for portability. Guardrails for safety. Your server for everything else.**

## Where HalfCloud is going

AI made building software dramatically easier.

**Deploying and operating it should be next.**

HalfCloud is exploring a world where running your own infrastructure doesn't require learning another platform, another configuration language or another dashboard.

You build.

You ship.

HalfCloud keeps it running.

**HalfCloud — Your servers. Zero complexity.**
