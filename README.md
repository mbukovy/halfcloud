# HalfCloud

> **HalfCloud is under active development. It is not ready for production apps yet.**

## Your app is built. Now put it online.

Building an app has never been easier.

You can describe an idea, watch AI write the code, and have something working by the end of the day. Then comes the part nobody asked for:

- setting up a server;
- figuring out domains and HTTPS;
- running databases and background jobs;
- restarting things when they break;
- reading logs that make no sense.

HalfCloud is built to handle that part.

Give it a server, open the chat, and tell it what you want:

> Put my app online.

> Run n8n for me.

> Add a database for my app.

> Why is my website down?

> Fix it and restart it.

HalfCloud does the server work for you.

## Hosting that speaks your language

You should not need to become a DevOps engineer just to share something you built.

HalfCloud gives you one simple place to:

- launch apps and services;
- give them a public web address;
- keep their data between restarts;
- see whether they are running;
- check server health and app logs;
- fix common problems through conversation.

There are no configuration files to memorize and no maze of cloud dashboards. Describe the result you want and HalfCloud works out the steps.

## One small server, your own cloud

HalfCloud runs on a VPS: an affordable computer you rent online. Providers such as Hetzner, DigitalOcean, Linode, Vultr, and many others can give you one in a few minutes.

That single server can hold your website, API, database, automations, workers, and other tools together.

You pay for the server instead of paying separately for every small piece of your app. Your apps and their data stay on infrastructure you control, without locking them into a custom hosting platform.

## AI that helps without owning the server

HalfCloud's AI can perform the everyday actions needed to run your apps, but it does not receive an unrestricted administrator terminal.

It works through a limited set of built-in actions. Risky operations ask for confirmation, and applications are kept away from the sensitive parts of the server by default.

This does not make hosting risk-free, but it is a more careful approach than giving an AI full control and hoping for the best.

## Install

For HalfCloud 0.1, start with a new Ubuntu 22.04 or newer VPS that is not being used for anything else. Choose an amd64 or arm64 server with a public IPv4 address, and make sure web traffic on ports 80 and 443 is allowed.

Connect to the server with SSH and run:

```bash
curl -fsSL https://raw.githubusercontent.com/mbukovy/halfcloud/main/install.sh | sudo bash
```

When installation finishes, it prints:

- a secure web address for your HalfCloud dashboard;
- an access code used to sign in.

Open the address, enter the code, connect your Azure OpenAI account, and tell HalfCloud what you want to run.

HalfCloud currently needs an existing app packaged as a container image. Support for deploying directly from source code is not available yet.

Before using a server that contains anything important, read [Install, uninstall, and update](docs/install-uninstall-update.md). The current uninstaller permanently removes HalfCloud, its applications, and its server data.

## Learn more

- [Getting started](docs/getting-started.md)
- [How HalfCloud works](docs/how-it-works.md)
- [Why HalfCloud is safer than giving AI full server access](docs/why-is-it-safe.md)
- [Operating your applications](docs/operating-applications.md)
- [Install, update, and uninstall](docs/install-uninstall-update.md)
- [Troubleshooting](docs/troubleshooting.md)
- [All documentation](docs/README.md)
