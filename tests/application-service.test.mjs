import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AppStore } from '../dist/backend/apps.js';
import { ApplicationService } from '../dist/backend/applications.js';
import { DomainStore } from '../dist/backend/domains.js';
import { EnvironmentStore } from '../dist/backend/environment.js';
import { RouteAccessRequestStore } from '../dist/backend/route-access.js';
import { RepositoryService } from '../dist/backend/repositories.js';

class FakeDocker {
  services = [];
  created = [];
  started = [];
  restarted = [];
  initializationCommands = [];
  networksDeleted = [];
  replaced = [];
  builds = new Map();
  replacements = new Map();

  async createContainer(input) {
    this.created.push(input);
    const service = {
      id: `container-${this.services.length + 1}`,
      name: input.serviceName,
      serviceId: input.serviceId,
      appId: input.appId,
      runtimeName: input.name,
      image: input.image,
      environment: input.environment ?? {},
      state: input.start === false ? 'exited' : 'running',
      status: input.start === false ? 'Created' : 'Up',
      ports: [],
      internalPorts: [],
      cpuPercent: 0,
      memoryUsed: 0,
      memoryLimit: 0,
    };
    this.services.push(service);
    return { id: service.id, name: service.name, running: service.state === 'running', steps: [] };
  }

  async listContainers() { return this.services; }
  async buildImage({ image }) {
    const imageId = `sha256:${createHash('sha256').update(image).digest('hex')}`;
    this.builds.set(image, imageId);
    return { image, imageId, logs: '' };
  }
  async inspectContainer(id) {
    const service = this.services.find((candidate) => candidate.id === id);
    assert.ok(service);
    return { ...service, imageId: this.builds.get(service.image), health: null, ports: service.ports.map((port) => ({ hostPort: port.host, target: `${port.container}/${port.protocol}` })) };
  }
  async beginContainerImageReplacement(id, image) {
    this.replaced.push({ id, image });
    const index = this.services.findIndex((service) => service.id === id);
    assert.notEqual(index, -1);
    const previous = this.services[index];
    const service = { ...previous, id: `${id}-replacement`, image };
    this.services[index] = service;
    const transaction = {
      containerId: service.id, name: service.runtimeName, state: service.state,
      commit: async () => { this.replacements.delete(service.serviceId); },
      rollback: async () => {
        this.services[index] = previous;
        this.replacements.delete(service.serviceId);
      },
    };
    this.replacements.set(service.serviceId, { appId: service.appId, transaction });
    return transaction;
  }
  async recoverContainerReplacements(committedApps = new Set(), appId) {
    for (const replacement of this.replacements.values()) {
      if (appId && replacement.appId !== appId) continue;
      await replacement.transaction[committedApps.has(replacement.appId) ? 'commit' : 'rollback']();
    }
  }
  async getContainerEnvironment(id) {
    const service = this.services.find((service) => service.id === id || service.serviceId === id);
    return { name: service.serviceId, environment: service.environment };
  }
  async startContainer(id) {
    this.started.push(id);
    const service = this.services.find((candidate) => candidate.id === id);
    if (service) service.state = 'running';
    return { containerId: id, state: 'running' };
  }
  async restartContainer(id) { this.restarted.push(id); return { containerId: id, state: 'running' }; }
  async runServiceInitializationCommand(id, command, networkMode) {
    this.initializationCommands.push({ id, command, networkMode });
    return { serviceId: this.services.find((service) => service.id === id)?.serviceId, exitCode: 0, completed: true };
  }
  async deleteContainer(id) { this.services = this.services.filter((service) => service.id !== id); }
  async deleteAppNetwork(id) { this.networksDeleted.push(id); return { deleted: true }; }
  async listManagedVolumes() { return []; }
}

test('deploys WordPress and MySQL as Services in one App and adds Redis to it', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'halfcloud-app-service-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runtime = new FakeDocker();
  const caddy = { async sync() {} };
  const applications = new ApplicationService(
    runtime,
    caddy,
    new DomainStore(directory),
    new EnvironmentStore(directory),
    new RouteAccessRequestStore(directory),
    async () => 'hash',
    new AppStore(directory),
  );

  const app = await applications.createApp({
    name: 'WordPress',
    services: [
      { name: 'wordpress', image: 'wordpress:latest', ports: {} },
      { name: 'mysql', image: 'mysql:8', ports: {}, namedVolumes: { data: '/var/lib/mysql' } },
    ],
  });

  assert.equal(app.name, 'WordPress');
  assert.equal(app.status, 'stopped');
  assert.deepEqual(app.services.map((service) => service.name), ['wordpress', 'mysql']);
  assert.equal(runtime.created.every((service) => service.start === false), true);
  assert.equal(new Set(runtime.services.map((service) => service.appId)).size, 1);
  assert.notEqual(runtime.services[0].runtimeName, runtime.services[0].name);

  const withRedis = await applications.addService('WordPress', { name: 'redis', image: 'redis:latest', ports: {} });
  assert.deepEqual(withRedis.services.map((service) => service.name), ['wordpress', 'mysql', 'redis']);
  assert.equal(withRedis.services.find((service) => service.name === 'redis').state, 'exited');
  assert.equal((await applications.listApps()).length, 1);

  await applications.startApp('WordPress');
  assert.deepEqual(runtime.started, ['container-1', 'container-2', 'container-3']);

  const renamed = await applications.renameApp(app.id, 'Company Website');
  assert.equal(renamed.id, app.id);
  assert.equal(runtime.services.length, 3);

  await applications.restartApp('Company Website');
  assert.deepEqual(runtime.restarted, ['container-1', 'container-2', 'container-3']);

  const initialized = await applications.runServiceInitializationCommand('Company Website', 'redis', ['redis-cli', '--cluster', 'fix'], 'service');
  assert.equal(initialized.completed, true);
  assert.deepEqual(runtime.initializationCommands, [{ id: 'container-3', command: ['redis-cli', '--cluster', 'fix'], networkMode: 'service' }]);
});

test('deleting a private Git App removes credentials before metadata and returns the remote cleanup URL', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'halfcloud-private-delete-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runtime = new FakeDocker();
  const apps = new AppStore(directory);
  const app = await apps.create('Private Source', {
    source: {
      type: 'git',
      url: 'https://github.com/example/private-app',
      gitUrl: 'git@github.com:example/private-app.git',
      provider: 'github',
      owner: 'example',
      repository: 'private-app',
      settingsUrl: 'https://github.com/example/private-app/settings/keys',
      authentication: 'ssh-deploy-key',
    },
    deployment: { status: 'in_progress', stage: 'awaiting_deploy_key', updatedAt: new Date().toISOString() },
  });
  let repositoryDeleted = false;
  const repositories = {
    async delete(appId) {
      assert.equal((await apps.get(appId)).id, app.id);
      repositoryDeleted = true;
    },
  };
  const applications = new ApplicationService(
    runtime,
    { async sync() {} },
    new DomainStore(directory),
    new EnvironmentStore(directory),
    new RouteAccessRequestStore(directory),
    async () => 'hash',
    apps,
    repositories,
  );

  const result = await applications.deleteApp(app.id);

  assert.equal(repositoryDeleted, true);
  assert.equal(result.deployKeyRemovalUrl, 'https://github.com/example/private-app/settings/keys');
  await assert.rejects(apps.get(app.id), /was not found/);
});

async function repositoryFixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'halfcloud-repository-app-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const apps = new AppStore(directory);
  const currentCommit = 'a'.repeat(40);
  const nextCommit = 'b'.repeat(40);
  const app = await apps.create('Repository App', {
    source: { type: 'git', url: 'https://github.com/example/project', branch: 'main', currentCommit, resolvedCommit: currentCommit },
  });
  const imagePrefix = `halfcloud/app-${app.id.slice(4).replaceAll('-', '')}:`;
  const oldImage = `${imagePrefix}${currentCommit.slice(0, 12)}-1`;
  await apps.update(app.id, {
    deployment: { status: 'running', stage: 'running', image: oldImage, buildAttempts: 1, updatedAt: new Date().toISOString() },
  });
  const checkout = path.join(directory, 'repositories', app.id, 'repository');
  await mkdir(checkout, { recursive: true });
  await writeFile(path.join(checkout, 'Dockerfile'), 'FROM scratch\n');
  const git = t.mock.fn(async (args) => ({ stdout: args.includes('rev-parse') ? `${nextCommit}\n` : '', stderr: '' }));
  const repositories = new RepositoryService(apps, path.join(directory, 'repositories'), async () => [{ address: '8.8.8.8' }], git);
  const runtime = new FakeDocker();
  const domains = new DomainStore(directory);
  const environment = new EnvironmentStore(directory);
  const caddy = { sync: t.mock.fn(async () => {}) };
  const applications = new ApplicationService(runtime, caddy, domains, environment, new RouteAccessRequestStore(directory), async () => 'hash', apps, repositories);
  t.mock.method(applications, 'waitForService', async () => {});
  await applications.addService(app.id, { name: 'worker', image: oldImage, ports: {}, environment: { API_KEY: 'protected-secret' } });
  await applications.addService(app.id, { name: 'redis', image: 'redis:7', ports: {} });
  await applications.startApp(app.id);
  const [worker, dependency] = structuredClone(runtime.services);
  return { applications, apps, app, runtime, domains, environment, caddy, git, worker, dependency, currentCommit, nextCommit, oldImage, imagePrefix };
}

test('refreshes and deploys a built image only to the selected Service without replacing its metadata or dependencies', async (t) => {
  const { applications, apps, app, runtime, domains, environment, caddy, worker, dependency, currentCommit, nextCommit } = await repositoryFixture(t);
  runtime.services[0].ports = [{ host: 10001, container: 3000, protocol: 'tcp' }];
  t.mock.method(domains, 'withReadiness', async (stored) => stored);
  const storedDomains = await domains.initialize(worker.serviceId, 'worker.example.com', 'custom.example.com');
  const storedEnvironment = await environment.initialize(worker.serviceId, worker.environment, true);
  const before = structuredClone(await applications.service(app.id, worker.serviceId));
  const progress = [];

  const refreshed = await applications.refreshGitRepository(app.name, (event) => progress.push(event));
  assert.equal(refreshed.appId, app.id);
  assert.equal(refreshed.changed, true);
  assert.equal(refreshed.source.resolvedCommit, nextCommit);
  assert.equal(refreshed.source.currentCommit, currentCommit);
  assert.deepEqual(progress, [{ phase: 'activity', label: 'Fetching latest Git changes' }]);
  assert.equal((await apps.get(app.id)).deployment.image, undefined);
  assert.equal((await apps.get(app.id)).deployment.status, 'in_progress');

  const built = await applications.buildRepositoryImage(app.id);
  assert.equal(built.commit, nextCommit);
  assert.equal((await apps.get(app.id)).deployment.image, built.image);
  assert.equal((await apps.get(app.id)).deployment.status, 'in_progress');
  assert.equal((await apps.get(app.id)).source.currentCommit, currentCommit);
  const deployed = await applications.deployRepositoryImage(app.id, worker.serviceId, built.image, '/ready');
  assert.deepEqual(applications.waitForService.mock.calls.at(-1).arguments, [app.id, worker.serviceId, built.imageId, '/ready']);

  assert.equal(deployed.appId, app.id);
  assert.equal(deployed.serviceId, worker.serviceId);
  assert.equal(deployed.image, built.image);
  assert.notEqual(deployed.containerId, worker.id);
  assert.deepEqual(runtime.replaced, [{ id: worker.id, image: built.image }]);
  assert.deepEqual(await applications.service(app.id, worker.serviceId), { ...before, id: deployed.containerId, image: built.image });
  assert.deepEqual(runtime.services[1], dependency);
  assert.equal(runtime.created.length, 2);
  assert.deepEqual(await domains.get(worker.serviceId), storedDomains);
  assert.deepEqual(await applications.listEnvironment(deployed.containerId), storedEnvironment);
  assert.deepEqual(await applications.listEnvironmentForAgent(deployed.containerId), {
    variables: [{ name: 'API_KEY', configured: true, protectedFromAI: true }],
  });
  const routes = caddy.sync.mock.calls.at(-1).arguments[0];
  assert.deepEqual(routes.find((service) => service.id === deployed.containerId).domains, storedDomains);
  const pending = await apps.get(app.id);
  assert.equal(pending.deployment.status, 'in_progress');
  assert.equal(pending.deployment.stage, 'deploying');
  assert.equal(pending.source.currentCommit, currentCommit);
});

test('requires the recorded successful image and rejects deployment targets belonging to another App', async (t) => {
  const { applications, apps, app, runtime, caddy, worker, oldImage, imagePrefix, nextCommit } = await repositoryFixture(t);
  const other = await applications.createApp({ name: 'Other App', services: [{ name: 'worker', image: 'busybox:latest', ports: {} }] });
  await applications.refreshGitRepository(app.id);
  await assert.rejects(applications.deployRepositoryImage(app.id, worker.serviceId, `${imagePrefix}${nextCommit.slice(0, 12)}-1`), /successfully built image for this App and commit/);
  const built = await applications.buildRepositoryImage(app.id);
  const before = await apps.get(app.id);
  const services = structuredClone(runtime.services);
  const routeSyncs = caddy.sync.mock.callCount();

  for (const image of [oldImage, 'nginx:latest', `${built.image}-other`]) {
    await assert.rejects(applications.deployRepositoryImage(app.id, worker.serviceId, image), /successfully built image for this App and commit/);
  }
  for (const target of [other.services[0].serviceId, other.services[0].id]) {
    await assert.rejects(applications.deployRepositoryImage(app.id, target, built.image), /was not found in Repository App/);
  }
  assert.deepEqual(await apps.get(app.id), before);
  assert.deepEqual(runtime.services, services);
  assert.deepEqual(runtime.replaced, []);
  assert.equal(caddy.sync.mock.callCount(), routeSyncs);
  await applications.deployRepositoryImage(app.id, worker.serviceId, built.image);
});

test('verification rejects another Service on an old repository image and completes private workers without ports', async (t) => {
  const { applications, apps, app, runtime, worker, dependency, oldImage, currentCommit, nextCommit } = await repositoryFixture(t);
  await applications.refreshGitRepository(app.id);
  const built = await applications.buildRepositoryImage(app.id);
  await applications.deployRepositoryImage(app.id, worker.serviceId, built.image);
  await applications.addService(app.id, { name: 'scheduler', image: oldImage, ports: {} });
  await applications.startService(app.id, 'scheduler');

  await assert.rejects(applications.verifyGitDeployment(app.id), /Build and deploy every repository Service at this commit/);
  const failed = await apps.get(app.id);
  assert.equal(failed.deployment.status, 'failed');
  assert.equal(failed.deployment.errorCode, 'verification_failed');
  assert.equal(failed.source.currentCommit, currentCommit);
  await applications.deployRepositoryImage(app.id, 'scheduler', built.image);
  assert.equal((await apps.get(app.id)).source.currentCommit, currentCommit);
  assert.equal(runtime.services.every((service) => service.ports.length === 0), true);

  assert.deepEqual(await applications.verifyGitDeployment(app.id), { appId: app.id, commit: nextCommit, verified: true, updateRecipesSaved: 2 });
  const verified = await apps.get(app.id);
  assert.equal(verified.deployment.status, 'running');
  assert.equal(verified.deployment.stage, 'running');
  assert.equal(verified.source.currentCommit, nextCommit);
  assert.deepEqual(runtime.services[1], dependency);
});

test('blocks refresh, build, deploy and verify for the same App while a build is running, then releases the guard', async (t) => {
  const { applications, apps, app, runtime, git, worker, oldImage } = await repositoryFixture(t);
  await applications.refreshGitRepository(app.id);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const buildImage = runtime.buildImage.bind(runtime);
  t.mock.method(runtime, 'buildImage', async (input) => {
    entered.resolve();
    await release.promise;
    return buildImage(input);
  });
  const building = applications.buildRepositoryImage(app.id);
  try {
    await entered.promise;
    const before = await apps.get(app.id);
    assert.equal(before.deployment.image, undefined);
    assert.equal(before.deployment.stage, 'building');
    const gitCalls = git.mock.callCount();
    for (const operation of [
      () => applications.refreshGitRepository(app.name),
      () => applications.buildRepositoryImage(app.name),
      () => applications.deployRepositoryImage(app.name, worker.serviceId, oldImage),
      () => applications.verifyGitDeployment(app.name),
      () => applications.inspectRepository(app.name),
      () => applications.writeRepositoryDeploymentFile(app.name, 'Dockerfile', 'FROM scratch\n'),
      () => applications.retryRepositoryBuild(app.name),
      () => applications.updateGitApp(app.name),
    ]) {
      await assert.rejects(operation(), /Another repository operation is in progress/);
    }
    assert.equal(git.mock.callCount(), gitCalls);
    assert.equal(runtime.buildImage.mock.callCount(), 1);
    assert.deepEqual(runtime.replaced, []);
    assert.deepEqual(await apps.get(app.id), before);
  } finally {
    release.resolve();
    await building;
  }
  assert.equal((await applications.refreshGitRepository(app.name)).changed, false);
});

test('a failed rebuild clears the pending image but retains recorded successful builds and existing Services', async (t) => {
  const { applications, apps, app, runtime, worker, currentCommit } = await repositoryFixture(t);
  await applications.refreshGitRepository(app.id);
  const built = await applications.buildRepositoryImage(app.id);
  const services = structuredClone((await applications.getApp(app.id)).services);
  t.mock.method(runtime, 'buildImage', async () => { throw new Error('Docker build failed'); });

  await assert.rejects(applications.buildRepositoryImage(app.id), /Docker build failed/);
  const failed = await apps.get(app.id);
  assert.equal(failed.deployment.image, undefined);
  assert.equal(failed.deployment.status, 'failed');
  assert.equal(failed.deployment.errorCode, 'build_failed');
  assert.equal(failed.deployment.buildAttempts, 1);
  assert.equal(failed.source.currentCommit, currentCommit);
  assert.deepEqual((await applications.getApp(app.id)).services, services);
  assert.deepEqual(runtime.replaced, []);
  assert.equal((await applications.deployRepositoryImage(app.id, worker.serviceId, built.image)).image, built.image);
  assert.equal((await applications.refreshGitRepository(app.id)).changed, false);
});
