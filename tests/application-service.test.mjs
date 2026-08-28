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
  restarted = [];
  networksDeleted = [];

  async createContainer(input) {
    const service = {
      id: `container-${this.services.length + 1}`,
      name: input.serviceName,
      serviceId: input.serviceId,
      appId: input.appId,
      runtimeName: input.name,
      image: input.image,
      state: 'running',
      status: 'Up',
      ports: [],
      internalPorts: [],
      cpuPercent: 0,
      memoryUsed: 0,
      memoryLimit: 0,
    };
    this.services.push(service);
    return { id: service.id, name: service.name, running: true, steps: [] };
  }

  async listContainers() { return this.services; }
  async restartContainer(id) { this.restarted.push(id); return { containerId: id, state: 'running' }; }
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
  assert.deepEqual(app.services.map((service) => service.name), ['wordpress', 'mysql']);
  assert.equal(new Set(runtime.services.map((service) => service.appId)).size, 1);
  assert.notEqual(runtime.services[0].runtimeName, runtime.services[0].name);

  const withRedis = await applications.addService('WordPress', { name: 'redis', image: 'redis:latest', ports: {} });
  assert.deepEqual(withRedis.services.map((service) => service.name), ['wordpress', 'mysql', 'redis']);
  assert.equal((await applications.listApps()).length, 1);

  const renamed = await applications.renameApp(app.id, 'Company Website');
  assert.equal(renamed.id, app.id);
  assert.equal(runtime.services.length, 3);

  await applications.restartApp('Company Website');
  assert.deepEqual(runtime.restarted, ['container-1', 'container-2', 'container-3']);
});
