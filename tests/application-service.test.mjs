import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AppStore } from '../dist/backend/apps.js';
import { ApplicationService } from '../dist/backend/applications.js';
import { DomainStore } from '../dist/backend/domains.js';
import { EnvironmentStore } from '../dist/backend/environment.js';
import { RouteAccessRequestStore } from '../dist/backend/route-access.js';

class FakeDocker {
  services = [];
  created = [];
  started = [];
  restarted = [];
  initializationCommands = [];
  networksDeleted = [];

  async createContainer(input) {
    this.created.push(input);
    const service = {
      id: `container-${this.services.length + 1}`,
      name: input.serviceName,
      serviceId: input.serviceId,
      appId: input.appId,
      runtimeName: input.name,
      image: input.image,
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
